#!/usr/bin/env python3
"""Standalone, local-first audio planning, preflight, mixing and QC.

Inference is deliberately invoked through direct Python providers; this module
never starts ComfyUI, talks to a browser, or uses a hosted API.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def read_json(file: Path, fallback: Any) -> Any:
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def latest(root: Path, pattern: str) -> Path | None:
    files = sorted(root.glob(pattern), key=lambda item: item.stat().st_mtime) if root.exists() else []
    return files[-1] if files else None


def require_tools() -> None:
    missing = [name for name in ("ffmpeg", "ffprobe") if not shutil.which(name)]
    if missing:
        raise RuntimeError(f"Missing required media tools: {', '.join(missing)}")


def preflight(provider: str) -> dict[str, Any]:
    result: dict[str, Any] = {"provider": provider, "ready": False, "comfyuiRequired": False, "problems": []}
    if provider == "higgs":
        runner = ROOT / "tools" / "tts_benchmark" / "higgs_tts.py"
        result["ready"] = runner.is_file()
        if not result["ready"]: result["problems"].append(f"Missing Higgs runner: {runner}")
    elif provider == "ace_step":
        runner = ROOT / "ACE-Step" / "acestep" / "inference.py"
        result["ready"] = runner.is_file()
        if not result["ready"]: result["problems"].append("Direct ACE-Step source is not installed")
    elif provider == "yue":
        # Existing weights are Comfy checkpoint files.  Do not disguise that
        # format as a standalone runtime: the provisioning command must add a
        # direct YuE runtime before a selected cue can run.
        runner = ROOT / "tools" / "providers" / "yue_direct.py"
        result["ready"] = runner.is_file()
        if not result["ready"]: result["problems"].append("YuE direct runner is not provisioned; ComfyUI is intentionally unsupported")
    else:
        result["problems"].append(f"Unknown local provider: {provider}")
    return result


def find_music_cues(audio_dir: Path) -> dict[str, Path]:
    """Discover unique music cue files in music and processed directories."""
    cues: dict[str, Path] = {}
    search_dirs = [audio_dir / "music", audio_dir / "music" / "v2", audio_dir / "processed"]
    for d in search_dirs:
        if not d.is_dir():
            continue
        for p in sorted(d.glob("*.*")):
            if p.is_file() and p.suffix.lower() in {".wav", ".flac", ".m4a", ".mp3"}:
                if "final_mix" in p.stem or "voice" in p.stem or p.name.startswith("."):
                    continue
                stem = p.stem.upper()
                for i in range(1, 20):
                    cid = f"M{i:02d}"
                    if stem == cid or stem.startswith(f"{cid}_") or stem.startswith(f"{cid}."):
                        if cid not in cues:
                            cues[cid] = p
                        break
                else:
                    if p.stem not in cues:
                        cues[p.stem] = p
    return cues


def load_cue_timings(project: Path) -> dict[str, dict[str, float]]:
    """Load cue timeline placement from editorial blueprint or audio plan."""
    timings: dict[str, dict[str, float]] = {}
    bp_dir = project / "04_visuals" / "plans"
    bp_files = sorted(bp_dir.glob("editorial_blueprint_v*.json"), reverse=True) if bp_dir.is_dir() else []
    for bp_file in bp_files:
        try:
            data = json.loads(bp_file.read_text(encoding="utf-8"))
            for b in data.get("beats", []):
                m = b.get("audio", {}).get("musicCueId")
                if not m:
                    continue
                s = float(b.get("timing", {}).get("startSeconds", 0))
                e = float(b.get("timing", {}).get("endSeconds", s))
                if m not in timings:
                    timings[m] = {"start": s, "end": e}
                else:
                    timings[m]["start"] = min(timings[m]["start"], s)
                    timings[m]["end"] = max(timings[m]["end"], e)
            if timings:
                return timings
        except Exception:
            pass
    return timings


def probe_duration(file_path: Path) -> float:
    """Return duration of media file in seconds via ffprobe."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(file_path)],
        check=True, capture_output=True, text=True,
    )
    data = json.loads(probe.stdout)
    return float(data.get("format", {}).get("duration", 0.0))


def mix(project: Path, output: Path) -> dict[str, Any]:
    require_tools()
    audio = project / "03_audio"
    voice = latest(audio / "takes", "*.wav") or latest(audio / "takes", "*.flac") or latest(audio / "takes", "*.m4a") or latest(audio / "takes", "*.mp3")
    if not voice:
        raise RuntimeError("No completed narration take exists under 03_audio/takes; finish voice synthesis before mixing")

    voice_duration = probe_duration(voice)
    cues = find_music_cues(audio)
    output.parent.mkdir(parents=True, exist_ok=True)

    if not cues:
        # Fallback to voice mastering if no music cues are generated yet
        command = [
            "ffmpeg", "-y", "-i", str(voice),
            "-af", "highpass=f=70,acompressor=threshold=-18dB:ratio=2.5,loudnorm=I=-14:TP=-1.5:LRA=9",
            "-ac", "2", "-ar", "48000", "-c:a", "pcm_s24le", str(output),
        ]
        subprocess.run(command, check=True)
    elif len(cues) == 1:
        # Single music cue: loop continuously under narration with sidechain ducking
        music_file = next(iter(cues.values()))
        filters = (
            "[0:a]highpass=f=70,acompressor=threshold=-18dB:ratio=2.5:attack=15:release=180,asplit=2[v_main][v_side];"
            "[1:a]volume=0.20,highpass=f=40[m_vol];"
            "[m_vol][v_side]sidechaincompress=threshold=0.025:ratio=4:attack=80:release=450[ducked];"
            "[v_main][ducked]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=9[out]"
        )
        command = [
            "ffmpeg", "-y", "-i", str(voice),
            "-stream_loop", "-1", "-i", str(music_file),
            "-filter_complex", filters,
            "-map", "[out]", "-shortest",
            "-ac", "2", "-ar", "48000", "-c:a", "pcm_s24le", str(output),
        ]
        subprocess.run(command, check=True)
    else:
        # Multi-cue soundtrack assembly with explicit timeline positioning and
        # voice ducking. A planned cue may never be silently replaced by the
        # opening/closing bed.
        timings = load_cue_timings(project)
        sorted_cue_keys = sorted(cues.keys())
        missing = [cue for cue in sorted_cue_keys if cue not in timings]
        if missing:
            raise RuntimeError(f"Music cues have no editorial timeline placement: {', '.join(missing)}")
        filter_parts = ["[0:a]highpass=f=70,acompressor=threshold=-18dB:ratio=2.5:attack=15:release=180,asplit=2[v_main][v_side]"]
        labels = []
        for index, cue_id in enumerate(sorted_cue_keys, start=1):
            timing = timings[cue_id]
            start = max(0.0, timing["start"])
            end = min(voice_duration, timing["end"])
            if end <= start:
                raise RuntimeError(f"Music cue {cue_id} has an invalid timeline range")
            label = f"m{index}"
            labels.append(f"[{label}]")
            filter_parts.append(
                f"[{index}:a]atrim=duration={end - start:.3f},asetpts=PTS-STARTPTS,"
                f"afade=t=in:st=0:d=0.35,afade=t=out:st={max(0.0, end - start - 0.5):.3f}:d=0.5,"
                f"adelay={int(start * 1000)}|{int(start * 1000)}[{label}]"
            )
        filter_parts.extend([
            f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0,volume=0.20,highpass=f=40[m_vol]",
            "[m_vol][v_side]sidechaincompress=threshold=0.025:ratio=4:attack=80:release=450[ducked]",
            "[v_main][ducked]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=9[out]",
        ])
        command = ["ffmpeg", "-y", "-i", str(voice)]
        for cue_id in sorted_cue_keys:
            command.extend(["-stream_loop", "-1", "-i", str(cues[cue_id])])
        command.extend(["-filter_complex", ";".join(filter_parts), "-map", "[out]", "-t", f"{voice_duration:.3f}", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s24le", str(output)])
        subprocess.run(command, check=True)

    version = output.stem.split("final_mix_v")[-1] if "final_mix_v" in output.stem else "1"
    report = output.with_name(f"qc_audio_v{version}.json")
    quality = qc(output, report)
    if not quality["passed"]:
        raise RuntimeError(f"Audio QC failed; inspect {report}")
    return {"voice": str(voice), "output": str(output), "musicInputs": len(cues), "qcReport": str(report)}


def qc(master: Path, report: Path) -> dict[str, Any]:
    require_tools()
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=sample_rate,channels", "-of", "json", str(master)], check=True, text=True, capture_output=True)
    data = json.loads(probe.stdout)
    stream = next((item for item in data.get("streams", []) if item.get("sample_rate")), {})
    loudness_run = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(master), "-filter_complex", "ebur128=peak=true", "-f", "null", "-"], text=True, capture_output=True)
    import re
    integrated = re.findall(r"I:\s*(-?\d+(?:\.\d+)?)\s*LUFS", loudness_run.stderr)
    peaks = re.findall(r"Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS", loudness_run.stderr)
    lufs = float(integrated[-1]) if integrated else None
    peak = float(peaks[-1]) if peaks else None
    checks = [
        {"id": "master_exists", "passed": master.is_file() and master.stat().st_size > 1024},
        {"id": "sample_rate_48khz", "passed": str(stream.get("sample_rate")) == "48000"},
        {"id": "has_duration", "passed": float(data.get("format", {}).get("duration") or 0) > 0},
        {"id": "integrated_loudness", "passed": lufs is not None and -14.5 <= lufs <= -13.5},
        {"id": "peak", "passed": peak is not None and peak <= -1.5},
    ]
    result = {"schemaVersion": 2, "master": str(master), "probe": data, "loudness": {"integratedLufs": lufs, "peakDbfs": peak}, "checks": checks, "passed": all(item["passed"] for item in checks)}
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project", type=Path)
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("preflight"); check.add_argument("--provider", choices=("higgs", "ace_step", "yue"), required=True)
    mixer = sub.add_parser("mix"); mixer.add_argument("--output", type=Path, required=True)
    checker = sub.add_parser("qc"); checker.add_argument("--master", type=Path, required=True); checker.add_argument("--report", type=Path, required=True)
    deliver = sub.add_parser("deliver"); deliver.add_argument("--master", type=Path, required=True); deliver.add_argument("--wav", type=Path, required=True); deliver.add_argument("--aac", type=Path, required=True)
    args = parser.parse_args(); project = args.project.resolve()
    if args.command == "preflight":
        result = preflight(args.provider); print(json.dumps(result, indent=2)); return 0 if result["ready"] else 2
    if args.command == "mix": print(json.dumps(mix(project, args.output.resolve()), indent=2)); return 0
    if args.command == "deliver":
        require_tools(); master, wav, aac = args.master.resolve(), args.wav.resolve(), args.aac.resolve()
        if not master.is_file(): raise RuntimeError("Review master does not exist")
        wav.parent.mkdir(parents=True, exist_ok=True); aac.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-y", "-i", str(master), "-ar", "48000", "-c:a", "pcm_s24le", str(wav)], check=True)
        subprocess.run(["ffmpeg", "-y", "-i", str(wav), "-c:a", "aac", "-b:a", "192k", str(aac)], check=True)
        print(json.dumps({"wav": str(wav), "aac": str(aac)}, indent=2)); return 0
    result = qc(args.master.resolve(), args.report.resolve()); print(json.dumps(result, indent=2)); return 0 if result["passed"] else 2
    return 1

if __name__ == "__main__":
    raise SystemExit(main())
