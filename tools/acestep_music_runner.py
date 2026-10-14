#!/usr/bin/env python3
"""
tools/acestep_music_runner.py — Soundtrack Cue Runner for Chitra Yantra.

Supports dual generation engines:
1. ACE-Step 1.5: Local Apple Silicon MLX REST API (/release_task & /query_result)
2. YuE2-3B: Local ComfyUI 48 kHz stereo flow-matching engine (via tools/yue2_music.py)

Invoked by tools/audio_pipeline.py:
    python tools/acestep_music_runner.py \\
        --manifest <manifest.json> \\
        --output-root <output_dir> \\
        --revision <rev> \\
        --api-url <url> \\
        --timeout <seconds> \\
        [--provider ace_step|yue] \\
        [--cue <id>] \\
        [--overwrite] \\
        [--suffix <suffix>]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave
from pathlib import Path
from typing import Any, Dict, List, Optional

# Add tools/ to sys.path for importing companion modules
TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))


def request_json(
    url: str,
    payload: Optional[Dict[str, Any]] = None,
    timeout: float = 30.0,
    headers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Perform HTTP request returning parsed JSON response."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req_headers = {"Content-Type": "application/json", "User-Agent": "ChitraYantra/MusicRunner"}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(
        url,
        data=data,
        headers=req_headers,
        method="POST" if data is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def generate_fallback_wav(path: Path, duration_seconds: float, frequency: float = 220.0) -> None:
    """Generate a clean ambient sine wave audio file when backend is offline or during testing."""
    path.parent.mkdir(parents=True, exist_ok=True)
    sample_rate = 44100
    num_samples = int(duration_seconds * sample_rate)
    with wave.open(str(path), "w") as wav_file:
        wav_file.setnchannels(2)  # Stereo
        wav_file.setsampwidth(2)  # 16-bit PCM
        wav_file.setframerate(sample_rate)

        # Gentle envelope with soft attack and decay
        attack_len = int(sample_rate * 1.5)
        decay_len = int(sample_rate * 2.0)
        frames = bytearray()

        for i in range(num_samples):
            # Amplitude envelope
            env = 1.0
            if i < attack_len:
                env = i / attack_len
            elif i > num_samples - decay_len:
                env = (num_samples - i) / decay_len

            # Pleasant two-tone ambient drone
            t = float(i) / sample_rate
            sample_val = 0.25 * math.sin(2.0 * math.pi * frequency * t) + \
                         0.15 * math.sin(2.0 * math.pi * (frequency * 1.5) * t) + \
                         0.08 * math.sin(2.0 * math.pi * (frequency * 0.5) * t)
            sample_val *= env
            sample_int = int(max(-32767, min(32767, sample_val * 32767.0)))
            # Write left and right channels
            frames.extend(struct.pack("<hh", sample_int, sample_int))

        wav_file.writeframes(frames)


def convert_to_wav(src: Path, dest: Path) -> None:
    """Ensure audio file is stored as PCM 16-bit 48kHz WAV."""
    if src.resolve() == dest.resolve() and src.suffix.lower() == ".wav":
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg_bin = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
    if os.path.isfile(ffmpeg_bin):
        tmp_dest = dest.with_suffix(".tmp.wav") if src.resolve() == dest.resolve() else dest
        cmd = [ffmpeg_bin, "-y", "-i", str(src), "-acodec", "pcm_s16le", "-ar", "48000", str(tmp_dest)]
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        if res.returncode == 0:
            if tmp_dest != dest:
                shutil.move(str(tmp_dest), str(dest))
            return
    # Fallback to direct copy if ffmpeg not available or failed
    if src.resolve() != dest.resolve():
        shutil.copy2(src, dest)


def generate_via_acestep_comfy(
    cue: Dict[str, Any],
    dest: Path,
    api_url: str,
    timeout: float,
) -> Dict[str, Any]:
    """Generate audio cue using ACE-Step 1.5 Turbo via ComfyUI."""
    import random
    prompt = str(cue.get("prompt") or cue.get("brief") or cue.get("id"))
    duration = float(cue.get("durationSeconds") or cue.get("duration") or 30.0)
    lyrics = "[Instrumental]" if cue.get("instrumental", True) else str(cue.get("lyrics", ""))
    seed = int(cue.get("seed") or random.randint(10000, 99999))
    bpm = int(cue.get("bpm") or 60)
    cue_id = str(cue.get("id") or cue.get("name") or "cue")

    workflow = {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {
                "unet_name": "acestep_v1.5_turbo.safetensors",
                "weight_dtype": "default",
            },
        },
        "2": {
            "class_type": "ModelSamplingAuraFlow",
            "inputs": {"model": ["1", 0], "shift": 3.0},
        },
        "3": {
            "class_type": "DualCLIPLoader",
            "inputs": {
                "clip_name1": "qwen_0.6b_ace15.safetensors",
                "clip_name2": "qwen_1.7b_ace15.safetensors",
                "type": "ace",
                "device": "default",
            },
        },
        "4": {
            "class_type": "TextEncodeAceStepAudio1.5",
            "inputs": {
                "clip": ["3", 0],
                "tags": prompt,
                "lyrics": lyrics,
                "seed": seed,
                "bpm": bpm,
                "duration": duration,
                "timesignature": "4",
                "language": "hi",
                "keyscale": str(cue.get("key") or "D minor"),
                "generate_audio_codes": True,
                "cfg_scale": 2.0,
                "temperature": 0.85,
                "top_p": 0.9,
                "top_k": 0,
                "min_p": 0.0,
            },
        },
        "5": {
            "class_type": "ConditioningZeroOut",
            "inputs": {"conditioning": ["4", 0]},
        },
        "6": {
            "class_type": "EmptyAceStep1.5LatentAudio",
            "inputs": {"seconds": duration, "batch_size": 1},
        },
        "7": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["2", 0],
                "seed": seed,
                "steps": 8,
                "cfg": 1.0,
                "sampler_name": "euler",
                "scheduler": "simple",
                "positive": ["4", 0],
                "negative": ["5", 0],
                "latent_image": ["6", 0],
                "denoise": 1.0,
            },
        },
        "8": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": "ace_1.5_vae.safetensors"},
        },
        "9": {
            "class_type": "VAEDecodeAudio",
            "inputs": {"samples": ["7", 0], "vae": ["8", 0]},
        },
        "10": {
            "class_type": "SaveAudio",
            "inputs": {
                "audio": ["9", 0],
                "filename_prefix": f"acestep/{cue_id}",
            },
        },
    }

    client_id = str(uuid.uuid4())
    queued = request_json(
        f"{api_url.rstrip('/')}/prompt",
        {"prompt": workflow, "client_id": client_id},
        timeout=30.0,
    )
    prompt_id = str(queued["prompt_id"])
    print(f"     ComfyUI ACE-Step task queued: {prompt_id}", flush=True)

    deadline = time.monotonic() + timeout
    poll_interval = 2.0
    while time.monotonic() < deadline:
        try:
            history = request_json(f"{api_url.rstrip('/')}/history/{prompt_id}", timeout=15.0)
            record = history.get(prompt_id)
            if isinstance(record, dict):
                status = record.get("status", {})
                if isinstance(status, dict) and status.get("status_str") == "error":
                    raise RuntimeError(f"ComfyUI ACE-Step error: {json.dumps(status, ensure_ascii=False)}")
                outputs = record.get("outputs", {})
                if isinstance(outputs, dict) and outputs.get("10"):
                    audio_items = outputs["10"].get("audio", [])
                    if audio_items:
                        item = audio_items[0]
                        filename = item.get("filename")
                        subfolder = item.get("subfolder", "")
                        # Try direct file system access first
                        configured_output = os.environ.get("COMFY_OUTPUT_DIR")
                        base_dirs = [Path(configured_output)] if configured_output else [Path.home() / "ComfyUI" / "output"]
                        for base_dir in base_dirs:
                            cand = base_dir / subfolder / filename
                            if cand.is_file():
                                convert_to_wav(cand, dest)
                                return {"status": "complete", "file": str(dest.resolve()), "engine": "ACE-Step 1.5 (ComfyUI Turbo)", "prompt_id": prompt_id}
                        # Fallback to HTTP download via /view
                        view_url = f"{api_url.rstrip('/')}/view?filename={urllib.parse.quote(filename)}&subfolder={urllib.parse.quote(subfolder)}&type=output"
                        temp_dl = dest.with_suffix(".dl.flac")
                        urllib.request.urlretrieve(view_url, str(temp_dl))
                        convert_to_wav(temp_dl, dest)
                        temp_dl.unlink(missing_ok=True)
                        return {"status": "complete", "file": str(dest.resolve()), "engine": "ACE-Step 1.5 (ComfyUI Turbo)", "prompt_id": prompt_id}
        except Exception as e:
            if "ComfyUI ACE-Step error" in str(e):
                raise
        time.sleep(poll_interval)

    raise TimeoutError(f"ACE-Step generation timed out after {timeout}s for prompt {prompt_id}")


def generate_via_acestep(
    cue: Dict[str, Any],
    dest: Path,
    api_url: str,
    timeout: float,
    allow_fallback: bool = False,
) -> Dict[str, Any]:
    """Generate audio cue using ACE-Step 1.5 via ComfyUI or standalone REST API."""
    prompt = str(cue.get("prompt") or cue.get("brief") or cue.get("id"))
    duration = float(cue.get("durationSeconds") or cue.get("duration") or 30.0)
    lyrics = "[Instrumental]" if cue.get("instrumental", True) else str(cue.get("lyrics", ""))

    # If targeting ComfyUI (standard port 8188 / 8190 or detected via /prompt), use native ComfyUI workflow
    is_comfy = any(p in api_url for p in [":8188", ":8190"])
    if not is_comfy:
        try:
            # Check if backend responds to ComfyUI system_stats
            check = request_json(f"{api_url.rstrip('/')}/system_stats", timeout=3.0)
            if "devices" in check or "system" in check:
                is_comfy = True
        except Exception:
            is_comfy = False

    if is_comfy:
        try:
            return generate_via_acestep_comfy(cue, dest, api_url, timeout)
        except Exception as err:
            if allow_fallback:
                print(f"     ⚠️ ComfyUI ACE-Step failed at {api_url} ({err}). Synthesizing reference audio...", flush=True)
                generate_fallback_wav(dest, duration, frequency=180.0)
                return {"status": "complete", "file": str(dest.resolve()), "engine": "ACE-Step 1.5 (Reference Synthesizer)", "note": f"ComfyUI error at {api_url}"}
            raise RuntimeError(f"ComfyUI ACE-Step generation failed at {api_url}: {err}")

    # Standalone REST API fallback (POST /release_task)
    payload = {
        "prompt": prompt,
        "lyrics": lyrics,
        "audio_duration": duration,
        "thinking": False,
        "vocal_language": "en",
    }

    try:
        release_resp = request_json(f"{api_url.rstrip('/')}/release_task", payload, timeout=30.0)
    except Exception as err:
        if allow_fallback:
            print(f"     ⚠️ ACE-Step server unreachable at {api_url} ({err}). Synthesizing reference audio...", flush=True)
            generate_fallback_wav(dest, duration, frequency=180.0)
            return {"status": "complete", "file": str(dest.resolve()), "engine": "ACE-Step 1.5 (Reference Synthesizer)", "note": f"Server offline at {api_url}"}
        raise RuntimeError(f"Cannot reach ACE-Step backend at {api_url}: {err}. Ensure ComfyUI or ACE-Step server is running.")

    task_id = (
        release_resp.get("data", {}).get("task_id")
        if isinstance(release_resp.get("data"), dict)
        else release_resp.get("task_id")
    )
    if not task_id:
        raise RuntimeError(f"No task_id returned by ACE-Step API: {release_resp}")

    print(f"     ACE-Step task queued: {task_id}", flush=True)
    deadline = time.monotonic() + timeout
    poll_interval = 2.0
    consecutive_poll_errors = 0

    while time.monotonic() < deadline:
        try:
            query_resp = request_json(
                f"{api_url.rstrip('/')}/query_result",
                {"task_id_list": [task_id]},
                timeout=15.0,
            )
            consecutive_poll_errors = 0
            items = query_resp.get("data", [])
            if items and isinstance(items, list):
                item = items[0]
                status = item.get("status")
                # status 0 = succeeded, status 1 = running/pending, status 2 = failed
                if status == 0:
                    raw_file = item.get("file")
                    if raw_file and Path(raw_file).is_file():
                        convert_to_wav(Path(raw_file), dest)
                        return {"status": "complete", "file": str(dest.resolve()), "engine": "ACE-Step 1.5", "task_id": task_id}
                    elif raw_file:
                        audio_url = f"{api_url.rstrip('/')}/v1/audio?path={urllib.parse.quote(raw_file)}"
                        temp_dl = dest.with_suffix(".dl.wav")
                        urllib.request.urlretrieve(audio_url, str(temp_dl))
                        convert_to_wav(temp_dl, dest)
                        temp_dl.unlink(missing_ok=True)
                        return {"status": "complete", "file": str(dest.resolve()), "engine": "ACE-Step 1.5", "task_id": task_id}
                elif status == 2:
                    error_msg = item.get("error") or "ACE-Step generation failed"
                    raise RuntimeError(f"ACE-Step task {task_id} failed: {error_msg}")
        except (urllib.error.URLError, OSError) as poll_err:
            consecutive_poll_errors += 1
            if consecutive_poll_errors % 10 == 0:
                print(f"     [polling] Waiting for ACE-Step backend response ({poll_err})...", flush=True)

        time.sleep(poll_interval)

    raise TimeoutError(f"ACE-Step generation timed out after {timeout}s for task {task_id}")


def generate_via_yue(
    cue: Dict[str, Any],
    dest: Path,
    api_url: str,
    timeout: float,
    allow_fallback: bool = False,
) -> Dict[str, Any]:
    """Generate audio cue using YuE2-3B via ComfyUI."""
    prompt = str(cue.get("prompt") or cue.get("brief") or cue.get("id"))
    duration = float(cue.get("durationSeconds") or cue.get("duration") or 30.0)
    lyrics = "[Instrumental]" if cue.get("instrumental", True) else str(cue.get("lyrics", ""))

    try:
        from yue2_music import generate_yue2_music  # type: ignore
        temp_out = dest.with_suffix(".flac")
        out_file, meta = generate_yue2_music(
            style=prompt,
            lyrics=lyrics,
            duration=duration,
            output_path=temp_out,
            api_url=api_url,
            timeout=timeout,
        )
        convert_to_wav(Path(out_file), dest)
        if temp_out != dest and temp_out.is_file():
            temp_out.unlink(missing_ok=True)
        return {"status": "complete", "file": str(dest.resolve()), "engine": "YuE2-3B", "metadata": meta}
    except Exception as err:
        if allow_fallback:
            print(f"     ⚠️ YuE2 / ComfyUI server unreachable at {api_url} ({err}). Synthesizing reference audio...", flush=True)
            generate_fallback_wav(dest, duration, frequency=240.0)
            return {"status": "complete", "file": str(dest.resolve()), "engine": "YuE2-3B (Reference Synthesizer)", "note": f"Server offline at {api_url}"}
        raise RuntimeError(f"YuE2 generation failed via ComfyUI at {api_url}: {err}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Chitra Yantra Soundtrack Cue Generator")
    parser.add_argument("--manifest", required=True, type=Path, help="Path to music_generation_manifest.json")
    parser.add_argument("--output-root", required=True, type=Path, help="Root directory for music cues (03_audio/music)")
    parser.add_argument("--revision", default="v1", help="Output revision label (e.g., v1, v2)")
    parser.add_argument("--api-url", default="http://127.0.0.1:8001", help="Backend API server URL")
    parser.add_argument("--timeout", type=float, default=2400.0, help="Per-cue timeout in seconds")
    parser.add_argument("--cue", action="append", default=[], help="Specific cue ID(s) to generate (default: all)")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing cue files")
    parser.add_argument("--suffix", default="", help="Suffix for versioned generation manifest")
    parser.add_argument("--provider", default=None, choices=["ace_step", "yue", "yue2"], help="Audio generation provider")
    parser.add_argument("--allow-fallback", action="store_true", help="Allow fallback to synthetic tone if backend is offline (testing only)")
    args = parser.parse_args()

    if not args.manifest.is_file():
        print(f"❌ Manifest not found: {args.manifest}", file=sys.stderr)
        return 1

    manifest_data = json.loads(args.manifest.read_text(encoding="utf-8"))
    cues: List[Dict[str, Any]] = manifest_data.get("cues", [])
    if not cues:
        print(f"❌ Manifest contains no cues: {args.manifest}", file=sys.stderr)
        return 1

    selected_provider = args.provider or manifest_data.get("provider", "ace_step")
    provider_key = "yue" if selected_provider in ("yue", "yue2") else "ace_step"

    # Destination directories:
    # 1. Revision subfolder: output_root / revision
    # 2. Base output_root: 03_audio/music (top-level for direct UI media scan)
    rev_dir = args.output_root / args.revision
    rev_dir.mkdir(parents=True, exist_ok=True)
    args.output_root.mkdir(parents=True, exist_ok=True)

    filter_cues = set(args.cue) if args.cue else None
    active_cues = [c for c in cues if not filter_cues or str(c.get("id")) in filter_cues]

    print(f"🎼 Soundtrack Generation ({len(active_cues)}/{len(cues)} cues)")
    print(f"   Provider    : {provider_key.upper()} ({'YuE2-3B' if provider_key == 'yue' else 'ACE-Step 1.5'})")
    print(f"   Output Root : {args.output_root}")
    print(f"   Revision    : {args.revision}")
    print(f"   Backend URL : {args.api_url}")
    print(f"   Overwrite   : {args.overwrite}")
    print("-" * 65, flush=True)

    records: List[Dict[str, Any]] = []

    for idx, cue in enumerate(active_cues, start=1):
        cue_id = str(cue["id"])
        duration = float(cue.get("durationSeconds") or cue.get("duration") or 30.0)
        target_stem = f"{cue_id}.wav"
        rev_target = rev_dir / target_stem
        top_target = args.output_root / target_stem

        # Cache check
        if not args.overwrite and rev_target.is_file() and rev_target.stat().st_size > 1024:
            print(f"[{idx}/{len(active_cues)}] Cue {cue_id}: cached ({rev_target.name})", flush=True)
            if not top_target.is_file():
                shutil.copy2(rev_target, top_target)
            records.append({
                "id": cue_id,
                "status": "complete",
                "cached": True,
                "provider": provider_key,
                "duration": duration,
                "file": str(top_target.resolve()),
                "revision_file": str(rev_target.resolve()),
            })
            continue

        print(f"[{idx}/{len(active_cues)}] Cue {cue_id}: generating {duration}s soundtrack...", flush=True)
        t0 = time.monotonic()

        if provider_key == "yue":
            result = generate_via_yue(cue, rev_target, args.api_url, args.timeout, allow_fallback=args.allow_fallback)
        else:
            result = generate_via_acestep(cue, rev_target, args.api_url, args.timeout, allow_fallback=args.allow_fallback)

        elapsed = round(time.monotonic() - t0, 2)
        # Ensure copy in base output_root so UI finds it immediately
        shutil.copy2(rev_target, top_target)

        record = {
            "id": cue_id,
            "status": "complete",
            "cached": False,
            "provider": provider_key,
            "duration": duration,
            "generation_time_sec": elapsed,
            "file": str(top_target.resolve()),
            "revision_file": str(rev_target.resolve()),
            **result,
        }
        records.append(record)
        print(f"     ✅ Saved: {top_target.name} ({elapsed}s)", flush=True)

    # Write generation_manifest.json as required by audio_pipeline.py status check
    manifest_name = f"generation_manifest{args.suffix}.json" if args.suffix else "generation_manifest.json"
    manifest_file = rev_dir / manifest_name
    manifest_file.write_text(json.dumps(records, indent=2, ensure_ascii=False), encoding="utf-8")
    print("-" * 65)
    print(f"✅ Soundtrack cues ready ({len(records)} completed)")
    print(f"   Manifest: {manifest_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
