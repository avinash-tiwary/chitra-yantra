#!/usr/bin/env python3
"""
tools/yue2_music.py — Programmatic YuE2-3B Music Generator
High-fidelity 48 kHz stereo music generation via ComfyUI MPS / REST API.

Supports:
- Text-to-Music (Lyrics + Genre/Style prompt)
- Instrumental Generation (No vocals)
- Symbolic Score Planning (Melody & Chords via ABC notation)
- Zero-Shot Cover Songs (Reference audio transcription via SheetSage2)
- Programmatic Python API & CLI interface for AI agents and Chitrayantra GUI.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


COMFY_API_URL = os.environ.get("COMFY_API_URL", "http://127.0.0.1:8188")
COMFY_OUTPUT_DIRS = [
    Path(item).expanduser()
    for item in os.environ.get(
        "COMFY_OUTPUT_DIRS",
        str(Path.home() / "ComfyUI" / "output"),
    ).split(os.pathsep)
    if item
]


def request_json(url: str, payload: Optional[Dict[str, Any]] = None, timeout: float = 60) -> Dict[str, Any]:
    """Perform HTTP GET or POST returning JSON response."""
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="GET" if data is None else "POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def build_yue2_workflow(
    style: str,
    lyrics: str,
    duration: float = 120.0,
    seed: int = 42,
    mode: str = "full",
    ckpt_name: str = "yue2_3b_bf16.safetensors",
    steps: int = 8,
    cfg: float = 1.0,
    temperature_abc: float = 0.7,
    temperature_music: float = 1.0,
    filename_prefix: str = "yue2/generated_track",
    cover_audio_path: Optional[str] = None,
    audio_encoder_name: str = "sheetsage2_bf16.safetensors",
) -> Dict[str, Any]:
    """Construct full ComfyUI execution graph for YuE2-3B."""

    nodes: Dict[str, Any] = {
        # 1. Load Checkpoint (UNET, CLIP, VAE)
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {
                "ckpt_name": ckpt_name,
            },
        },
    }

    is_instrumental = lyrics.strip().lower() in ["[instrumental]", "instrumental", ""]
    if mode == "off" or is_instrumental and not cover_audio_path:
        # Direct generation (Fastest: bypasses symbolic ABC generation)
        nodes["5"] = {
            "class_type": "YuE2GenerateMusic",
            "inputs": {
                "clip": ["1", 1],
                "style": style,
                "lyrics": "[Instrumental]" if is_instrumental else lyrics,
                "abc": "",
                "seed": seed,
                "mode": "full",
                "max_duration": float(duration),
                "temperature": float(temperature_music),
                "top_p": 0.95,
                "top_k": 100,
                "repetition_penalty": 1.2,
            },
        }
    elif cover_audio_path:
        # Cover song workflow via SheetSage2
        nodes["2"] = {
            "class_type": "AudioEncoderLoader",
            "inputs": {
                "audio_encoder_name": audio_encoder_name,
            },
        }
        nodes["3"] = {
            "class_type": "LoadAudio",
            "inputs": {
                "audio": str(cover_audio_path),
            },
        }
        nodes["4"] = {
            "class_type": "SheetSage2AudioToABC",
            "inputs": {
                "audio_encoder": ["2", 0],
                "audio": ["3", 0],
                "mode": mode if mode in ["melody", "full"] else "melody",
            },
        }
        # YuE2 Music Conditioning with SheetSage2 ABC score
        nodes["5"] = {
            "class_type": "YuE2GenerateMusic",
            "inputs": {
                "clip": ["1", 1],
                "style": style,
                "lyrics": lyrics,
                "abc": ["4", 0],
                "seed": seed,
                "mode": mode if mode in ["melody", "full"] else "melody",
                "max_duration": float(duration),
                "temperature": float(temperature_music),
                "top_p": 0.95,
                "top_k": 100,
                "repetition_penalty": 1.2,
            },
        }
    else:
        # Text-to-Music with Symbolic Planning (ABC Generation capped at 512 tokens)
        nodes["2"] = {
            "class_type": "YuE2GenerateABC",
            "inputs": {
                "clip": ["1", 1],
                "style": style,
                "lyrics": lyrics,
                "seed": seed,
                "mode": mode if mode in ["melody", "full"] else "full",
                "max_abc_tokens": 512,
                "temperature": float(temperature_abc),
                "top_p": 0.9,
                "top_k": 30,
                "repetition_penalty": 1.005,
                "penalty_window": 100,
            },
        }
        # YuE2 Music Conditioning
        nodes["5"] = {
            "class_type": "YuE2GenerateMusic",
            "inputs": {
                "clip": ["1", 1],
                "style": style,
                "lyrics": lyrics,
                "abc": ["2", 0],
                "seed": seed,
                "mode": mode if mode in ["melody", "full"] else "full",
                "max_duration": float(duration),
                "temperature": float(temperature_music),
                "top_p": 0.95,
                "top_k": 100,
                "repetition_penalty": 1.2,
            },
        }

    # Empty Latent Audio with dynamic seconds
    nodes["6"] = {
        "class_type": "EmptyYuE2LatentAudio",
        "inputs": {
            "seconds": ["5", 1],
            "batch_size": 1,
        },
    }

    # KSampler for flow matching latent generation
    nodes["7"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["1", 0],
            "positive": ["5", 0],
            "negative": ["5", 0],
            "latent_image": ["6", 0],
            "seed": seed,
            "steps": int(steps),
            "cfg": float(cfg),
            "sampler_name": "euler",
            "scheduler": "simple",
            "denoise": 1.0,
        },
    }

    # VAE Decode
    nodes["8"] = {
        "class_type": "VAEDecodeAudio",
        "inputs": {
            "samples": ["7", 0],
            "vae": ["1", 2],
        },
    }

    # Save Output Audio
    nodes["9"] = {
        "class_type": "SaveAudio",
        "inputs": {
            "audio": ["8", 0],
            "filename_prefix": filename_prefix,
        },
    }

    return nodes


def wait_for_completion(
    prompt_id: str,
    api_url: str = COMFY_API_URL,
    timeout: float = 1200,
    poll_interval: float = 3.0,
) -> Dict[str, Any]:
    """Poll ComfyUI until prompt completes or errors out."""
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        try:
            history = request_json(f"{api_url}/history/{prompt_id}")
            if prompt_id in history:
                record = history[prompt_id]
                status = record.get("status", {})
                if status.get("status_str") == "error":
                    messages = status.get("messages", [])
                    raise RuntimeError(f"ComfyUI execution error: {messages}")

                outputs = record.get("outputs", {})
                if outputs:
                    return outputs
        except urllib.error.URLError:
            pass

        time.sleep(poll_interval)

    raise TimeoutError(f"YuE2 generation timed out after {timeout}s for prompt {prompt_id}")


def locate_output_file(output_info: Dict[str, Any]) -> Path:
    """Find the generated audio file on disk from node outputs."""
    audio_items = []
    for node_id, node_output in output_info.items():
        if isinstance(node_output, dict) and "audio" in node_output:
            audio_items.extend(node_output["audio"])

    if not audio_items:
        raise FileNotFoundError(f"No audio file in ComfyUI output: {output_info}")

    item = audio_items[0]
    filename = item.get("filename")
    subfolder = item.get("subfolder", "")

    for base_dir in COMFY_OUTPUT_DIRS:
        candidate = base_dir / subfolder / filename
        if candidate.is_file():
            return candidate

    raise FileNotFoundError(f"Output audio {filename} not found in {COMFY_OUTPUT_DIRS}")


def get_default_checkpoint() -> str:
    """Auto-detect the best available YuE2 checkpoint."""
    candidates = [
        "yue2_3b_bf16.safetensors",
        "yue2_3b_int8_convrot.safetensors",
    ]
    configured_dirs = os.environ.get("COMFY_CHECKPOINT_DIRS")
    search_dirs = ([Path(item).expanduser() for item in configured_dirs.split(os.pathsep) if item] if configured_dirs else [
        Path.home() / "ComfyUI" / "models" / "checkpoints",
    ])
    for c in candidates:
        for d in search_dirs:
            p = d / c
            # Only use if file exists and is not actively downloading (.aria2 file absent)
            if p.is_file() and not (d / f"{c}.aria2").is_file():
                return c
    return "yue2_3b_int8_convrot.safetensors"


def generate_yue2_music(
    style: str,
    lyrics: str = "[Instrumental]",
    duration: float = 90.0,
    seed: Optional[int] = None,
    mode: str = "full",
    output_path: Optional[Path | str] = None,
    ckpt_name: Optional[str] = None,
    steps: int = 8,
    api_url: str = COMFY_API_URL,
    cover_audio: Optional[str] = None,
    timeout: float = 1200,
) -> Tuple[Path, Dict[str, Any]]:
    """Programmatic API to generate music via YuE2-3B.

    Args:
        style: Genre/instrumentation/vocal style prompt.
        lyrics: Lyrics text (or '[Instrumental]').
        duration: Desired duration in seconds.
        seed: Random seed for reproducibility.
        mode: 'full' (melody+chords), 'melody' (melody only), 'off' (direct).
        output_path: Destination path for the saved audio file.
        ckpt_name: Checkpoint name in models/checkpoints.
        steps: KSampler inference steps (default 8).
        api_url: ComfyUI server URL.
        cover_audio: Path to reference audio for cover songs.
        timeout: Maximum seconds to wait.

    Returns:
        (saved_audio_path, metadata_dict)
    """
    if seed is None:
        seed = random.randint(1, 2**32 - 1)
    if ckpt_name is None:
        ckpt_name = get_default_checkpoint()

    unique_prefix = f"yue2/{uuid.uuid4().hex[:8]}"
    workflow_graph = build_yue2_workflow(
        style=style,
        lyrics=lyrics,
        duration=duration,
        seed=seed,
        mode=mode,
        ckpt_name=ckpt_name,
        steps=steps,
        filename_prefix=unique_prefix,
        cover_audio_path=cover_audio,
    )

    client_id = str(uuid.uuid4())
    payload = {"prompt": workflow_graph, "client_id": client_id}

    t0 = time.time()
    queue_resp = request_json(f"{api_url}/prompt", payload)
    prompt_id = queue_resp.get("prompt_id")
    if not prompt_id:
        raise RuntimeError(f"Failed to queue prompt: {queue_resp}")

    outputs = wait_for_completion(prompt_id, api_url=api_url, timeout=timeout)
    src_file = locate_output_file(outputs)
    elapsed = time.time() - t0

    if output_path is not None:
        dest = Path(output_path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_file, dest)
        final_file = dest
    else:
        final_file = src_file

    meta = {
        "engine": "YuE2-3B",
        "checkpoint": ckpt_name,
        "style": style,
        "lyrics": lyrics,
        "duration": duration,
        "seed": seed,
        "mode": mode,
        "steps": steps,
        "generation_time_sec": round(elapsed, 2),
        "prompt_id": prompt_id,
        "output_file": str(final_file.resolve()),
    }

    return final_file, meta


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate 48 kHz stereo music with YuE2-3B via ComfyUI MPS",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--style", "-s", required=True, help="Style/genre/instrumentation prompt")
    parser.add_argument("--lyrics", "-l", default="[Instrumental]", help="Lyrics text or path to lyrics file")
    parser.add_argument("--instrumental", action="store_true", help="Force instrumental mode")
    parser.add_argument("--duration", "-d", type=float, default=90.0, help="Duration in seconds (default: 90)")
    parser.add_argument("--seed", type=int, default=None, help="Random seed")
    parser.add_argument("--mode", choices=["full", "melody", "off"], default="full", help="Planning mode")
    parser.add_argument("--output", "-o", type=Path, default=None, help="Output file destination path")
    parser.add_argument("--cover", type=str, default=None, help="Reference audio path for cover song generation")
    parser.add_argument("--steps", type=int, default=8, help="KSampler steps (default: 8)")
    parser.add_argument("--api-url", default=COMFY_API_URL, help=f"ComfyUI URL (default: {COMFY_API_URL})")
    args = parser.parse_args()

    lyrics_text = args.lyrics
    if Path(lyrics_text).is_file():
        lyrics_text = Path(lyrics_text).read_text(encoding="utf-8")

    if args.instrumental:
        lyrics_text = "[Instrumental]"

    out_dest = args.output
    if out_dest is None:
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        out_dest = Path(f"output_yue2_{timestamp}.flac")

    print(f"🎵 YuE2-3B Music Generation")
    print(f"   Style    : {args.style}")
    print(f"   Mode     : {args.mode}")
    print(f"   Duration : {args.duration}s")
    print(f"   Output   : {out_dest}")
    print(f"   Server   : {args.api_url}")
    print("⏳ Generating music...")

    try:
        final_path, meta = generate_yue2_music(
            style=args.style,
            lyrics=lyrics_text,
            duration=args.duration,
            seed=args.seed,
            mode=args.mode,
            output_path=out_dest,
            steps=args.steps,
            api_url=args.api_url,
            cover_audio=args.cover,
        )
        print(f"✅ Success! Saved to: {final_path}")
        print(f"⚡ Time elapsed: {meta['generation_time_sec']}s")
        return 0
    except Exception as e:
        print(f"❌ Generation failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
