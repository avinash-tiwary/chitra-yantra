#!/usr/bin/env python3
"""Resumable project CLI for narration and original-music generation."""

from __future__ import annotations

import argparse
import copy
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]


def load_config(path: Path) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    with resolved.open("r", encoding="utf-8") as handle:
        config = json.load(handle)
    if config.get("schema_version") != 1:
        raise ValueError(f"Unsupported config schema in {resolved}")
    for section in ("voice", "music"):
        if not isinstance(config.get(section), dict):
            raise ValueError(f"Config is missing the {section!r} section")
    config["_path"] = str(resolved)
    return config


def repo_path(value: str) -> Path:
    path = Path(value).expanduser()
    # Do not resolve symlinks here: resolving a virtualenv's `bin/python` to the
    # base interpreter disables that virtualenv when the command is launched.
    return path if path.is_absolute() else REPO_ROOT / path


def display_command(command: list[str]) -> str:
    return " ".join(subprocess.list2cmdline([item]) for item in command)


def run_command(command: list[str], dry_run: bool = False) -> None:
    print(f"$ {display_command(command)}", flush=True)
    if not dry_run:
        # launchd starts jobs with a minimal PATH.  Keep locally installed
        # media tools (notably Homebrew ffmpeg used for M4A references)
        # discoverable without requiring the config UI or a shell profile.
        environment = os.environ.copy()
        tool_paths = ["/opt/homebrew/bin", "/usr/local/bin"]
        environment["PATH"] = ":".join(tool_paths + [environment.get("PATH", "")])
        subprocess.run(command, cwd=REPO_ROOT, check=True, env=environment)


def backend_ready(api_url: str) -> bool:
    for endpoint in ("/system_stats", "/health", "/v1/stats", "/docs"):
        try:
            req = urllib.request.Request(
                f"{api_url.rstrip('/')}{endpoint}",
                headers={"User-Agent": "ChitraYantra/AudioPipeline"},
            )
            with urllib.request.urlopen(req, timeout=3) as response:
                if response.status in (200, 307, 308):
                    return True
        except (OSError, urllib.error.URLError):
            pass
    return False


def start_music_backend(
    config: dict[str, Any], dry_run: bool
) -> tuple[subprocess.Popen[str], Any, Path] | None:
    music = config["music"]
    api_url = str(music.get("api_url", "http://127.0.0.1:8190"))
    if backend_ready(api_url):
        print(f"Using existing headless audio backend at {api_url}", flush=True)
        return None
    backend = music.get("backend")
    if not isinstance(backend, dict):
        raise RuntimeError(f"No backend is running at {api_url} and music.backend is not configured")
    for item in backend.get("required_weights", []):
        weight = repo_path(str(item))
        if not weight.is_file():
            raise FileNotFoundError(f"Required local weight is missing (downloads are disabled): {weight}")
    command = [
        str(repo_path(str(item)))
        if str(item).startswith(("/", ".")) or "/" in str(item)
        else str(item)
        for item in backend["command"]
    ]
    cwd = repo_path(str(backend["cwd"]))
    log_path = repo_path(str(backend["log_file"]))
    print(f"$ {display_command(command)}", flush=True)
    if dry_run:
        return None
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_handle = log_path.open("a", encoding="utf-8")
    log_handle.write(f"\n--- headless backend start {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
    log_handle.flush()
    environment = os.environ.copy()
    environment.update({str(key): str(value) for key, value in backend.get("environment", {}).items()})
    process = subprocess.Popen(
        command,
        cwd=cwd,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
        env=environment,
    )
    deadline = time.monotonic() + float(backend.get("startup_timeout", 240))
    while time.monotonic() < deadline:
        if process.poll() is not None:
            log_handle.close()
            tail = "\n".join(log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-30:])
            raise RuntimeError(f"Headless backend exited with {process.returncode}:\n{tail}")
        if backend_ready(api_url):
            print(f"Headless audio backend ready at {api_url}", flush=True)
            return process, log_handle, log_path
        time.sleep(2)
    process.terminate()
    log_handle.close()
    raise TimeoutError(f"Headless backend did not become ready; inspect {log_path}")


def stop_music_backend(started: tuple[subprocess.Popen[str], Any, Path] | None) -> None:
    if started is None:
        return
    process, log_handle, _ = started
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
    log_handle.close()
    print("Stopped the headless audio backend.", flush=True)


def voice_command(config: dict[str, Any], suffix: str = "", only_chunk: int | None = None, force_chunk: int | None = None) -> tuple[list[str], Path, int]:
    voice = config["voice"]
    python = repo_path(str(voice.get("python", ".venv_tts_benchmark/bin/python")))
    script = repo_path(str(voice.get("script", "tools/tts_benchmark/higgs_tts.py")))
    base_output = repo_path(str(voice["output"]))
    if suffix:
        output = base_output.with_name(f"{base_output.stem}{suffix}{base_output.suffix}")
        metadata = output.with_suffix(".json")
    else:
        output = base_output
        metadata = repo_path(str(voice.get("metadata", output.with_suffix(".json"))))
    command = [
        str(python),
        str(script),
        str(repo_path(str(voice["text_file"]))),
        "--output",
        str(output),
        "--metadata",
        str(metadata),
        "--chunk-dir",
        str(repo_path(str(voice["chunk_dir"]))),
        "--model",
        str(repo_path(str(voice.get("model", "tools/tts_benchmark/models/higgs")))),
        "--max-chars",
        str(int(voice.get("max_chars", 320))),
        "--temperature",
        str(float(voice.get("temperature", 0.65))),
        "--top-p",
        str(float(voice.get("top_p", 0.9))),
        "--top-k",
        str(int(voice.get("top_k", 50))),
        "--max-new-tokens",
        str(int(voice.get("max_new_tokens", 2048))),
        "--pause-ms",
        str(float(voice.get("pause_ms", 100))),
        "--retries",
        str(int(voice.get("retries", 3))),
        "--generate-limit",
        str(int(voice.get("fresh_process_batch_chunks", 6))),
    ]
    if voice.get("no_reference"):
        command.append("--no-reference")
    else:
        command.extend(
            [
                "--reference-audio",
                str(repo_path(str(voice["reference_audio"]))),
                "--reference-text-file",
                str(repo_path(str(voice["reference_text_file"]))),
            ]
        )
    if voice.get("emotion"):
        command.extend(["--emotion", str(voice["emotion"])])
    if voice.get("seed") is not None:
        command.extend(["--seed", str(int(voice["seed"]))])
    if voice.get("max_rss_mb") is not None:
        command.extend(["--max-rss-mb", str(int(voice["max_rss_mb"]))])
    if voice.get("defer_validation"):
        command.append("--defer-validation")
    if only_chunk is not None:
        command.extend(["--only-chunk", str(only_chunk)])
    if force_chunk is not None:
        command.extend(["--force-chunk", str(force_chunk)])
    return command, metadata, int(voice.get("fresh_process_batch_chunks", 6))


def prepare_narration_manifest(config: dict[str, Any], dry_run: bool = False) -> dict[str, Any]:
    """Compile Markdown once into a TTS-safe, checkpoint-stable chunk manifest."""
    prepared = copy.deepcopy(config)
    voice = prepared["voice"]
    source = repo_path(str(voice["text_file"]))
    if source.suffix.lower() == ".json":
        return prepared
    output = repo_path(str(voice["output"]))
    language = str(voice.get("language") or ("hindi" if "hindi" in source.stem.lower() else "english" if "english" in source.stem.lower() else "und"))
    manifest = output.parent.parent / "plans" / f"narration_{source.stem}.json"
    command = [
        sys.executable,
        str(REPO_ROOT / "tools" / "narration_compiler.py"),
        str(source), "--output", str(manifest), "--language", language,
        "--max-chars", str(int(voice.get("max_chars", 320))),
    ]
    run_command(command, dry_run=dry_run)
    voice["text_file"] = str(manifest)
    voice["narration_manifest"] = str(manifest)
    return prepared


def generate_voice(
    config: dict[str, Any], one_batch: bool, dry_run: bool, suffix: str = "", only_chunk: int | None = None,
    force_chunk: int | None = None,
) -> None:
    prepared = prepare_narration_manifest(config, dry_run=dry_run)
    command, metadata, batch_size = voice_command(prepared, suffix=suffix, only_chunk=only_chunk, force_chunk=force_chunk)
    if batch_size < 1:
        raise ValueError("voice.fresh_process_batch_chunks must be at least 1")
    prior_complete = -1
    while True:
        run_command(command, dry_run=dry_run)
        if only_chunk is not None:
            return
        if dry_run:
            return
        if not metadata.is_file():
            raise RuntimeError(f"Voice worker did not write progress metadata: {metadata}")
        report = json.loads(metadata.read_text(encoding="utf-8"))
        complete = int(report.get("chunks_complete", 0))
        total = int(report.get("chunks_total", 0))
        print(f"Voice progress: {complete}/{total} chunks", flush=True)
        if report.get("complete"):
            print(f"Narration complete: {report['output']}", flush=True)
            return
        if complete <= prior_complete:
            raise RuntimeError("Voice generation made no checkpoint progress")
        if one_batch:
            print("Stopped after one isolated batch; rerun `voice` to resume.", flush=True)
            return
        prior_complete = complete
        time.sleep(2.0)


def generate_music(
    config: dict[str, Any],
    cues: list[str],
    overwrite: bool,
    dry_run: bool,
    suffix: str = "",
) -> None:
    music = config["music"]
    python_value = str(music.get("python", sys.executable))
    python = repo_path(python_value) if "/" in python_value else Path(python_value)
    command = [
        str(python),
        str(repo_path(str(music["script"]))),
        "--manifest",
        str(repo_path(str(music["manifest"]))),
        "--output-root",
        str(repo_path(str(music["output_root"]))),
        "--revision",
        str(music.get("revision", "r01")),
        "--api-url",
        str(music.get("api_url", "http://127.0.0.1:8190")),
        "--timeout",
        str(float(music.get("timeout", 2400))),
    ]
    for cue in cues:
        command.extend(["--cue", cue])
    if overwrite:
        command.append("--overwrite")
    if suffix:
        command.extend(["--suffix", suffix])
    provider = str(music.get("provider", "ace_step"))
    if provider:
        command.extend(["--provider", provider])
    if dry_run:
        command.append("--allow-fallback")
    started = start_music_backend(config, dry_run=dry_run)
    try:
        run_command(command, dry_run=dry_run)
    finally:
        stop_music_backend(started)


def status(config: dict[str, Any], suffix: str = "") -> int:
    voice = config["voice"]
    base_output = repo_path(str(voice["output"]))
    if suffix:
        output = base_output.with_name(f"{base_output.stem}{suffix}{base_output.suffix}")
        metadata = output.with_suffix(".json")
    else:
        output = base_output
        metadata = repo_path(str(voice.get("metadata", output.with_suffix(".json"))))
    if metadata.is_file():
        report = json.loads(metadata.read_text(encoding="utf-8"))
        state = "complete" if report.get("complete") else "in progress"
        print(
            f"Voice: {state} ({report.get('chunks_complete', 0)}/"
            f"{report.get('chunks_total', '?')} chunks)"
        )
        if report.get("output"):
            print(f"  {report['output']}")
    else:
        checkpoint_dir = repo_path(str(voice["chunk_dir"]))
        checkpoint_count = len(list(checkpoint_dir.glob("chunk_*.json")))
        if checkpoint_count:
            print(f"Voice: interrupted before batch summary ({checkpoint_count} chunks checkpointed)")
            print(f"  {checkpoint_dir}")
        else:
            print("Voice: not started")

    music = config["music"]
    revision = str(music.get("revision", "r01"))
    manifest_name = f"generation_manifest{suffix}.json" if suffix else "generation_manifest.json"
    manifest = repo_path(str(music["output_root"])) / revision / manifest_name
    expected = 0
    source_manifest = repo_path(str(music["manifest"]))
    if source_manifest.is_file():
        expected = len(json.loads(source_manifest.read_text(encoding="utf-8")).get("cues", []))
    if manifest.is_file():
        records = json.loads(manifest.read_text(encoding="utf-8"))
        completed = sum(1 for item in records if item.get("status") == "complete")
        print(f"Music: {'complete' if completed == expected else 'in progress'} ({completed}/{expected} cues)")
        print(f"  {manifest.parent}")
    else:
        print(f"Music: not started (0/{expected} cues)")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate resumable project narration and music with isolated voice batches."
    )
    parser.add_argument("config", type=Path, help="Project audio_pipeline.json")
    parser.add_argument("command", choices=("status", "voice", "music", "all"))
    parser.add_argument("--one-batch", action="store_true", help="Stop voice after one fresh process batch")
    parser.add_argument("--only-chunk", type=int, default=None, help="Generate one narration chunk")
    parser.add_argument("--force-chunk", type=int, default=None, help="Regenerate a numbered chunk even when its checkpoint is valid")
    parser.add_argument("--cue", action="append", default=[], help="Music cue ID; repeat as needed")
    parser.add_argument("--overwrite-music", action="store_true")
    parser.add_argument("--suffix", default="", help="Optional output filename suffix, e.g. _anti_gravity")
    parser.add_argument("--output", type=Path, help="Override voice output for an additive pipeline take")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = load_config(args.config)
    if args.output:
        config = copy.deepcopy(config)
        output = args.output.expanduser().resolve()
        config["voice"]["output"] = str(output)
        config["voice"]["metadata"] = str(output.with_suffix(".json"))
        config["voice"]["chunk_dir"] = str(output.parent / f"{output.stem}_chunks")
    if args.command == "status":
        return status(config, suffix=args.suffix)
    if args.command in {"voice", "all"}:
        generate_voice(
            config,
            one_batch=args.one_batch,
            dry_run=args.dry_run,
            suffix=args.suffix,
            only_chunk=args.only_chunk,
            force_chunk=args.force_chunk,
        )
    if args.command in {"music", "all"}:
        generate_music(
            config,
            args.cue,
            args.overwrite_music,
            args.dry_run,
            suffix=args.suffix,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
