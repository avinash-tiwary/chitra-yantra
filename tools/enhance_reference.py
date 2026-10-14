#!/usr/bin/env python3
"""Create a normalized DeepFilterNet reference preview from one local audio file."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    source = args.input.resolve()
    output = args.output.resolve()
    if not source.is_file():
        raise FileNotFoundError(f"Reference source does not exist: {source}")
    output.parent.mkdir(parents=True, exist_ok=True)
    normalized = output.with_name(f".{output.stem}.normalized.wav")
    try:
        subprocess.run([
            "ffmpeg", "-y", "-i", str(source), "-ac", "1", "-ar", "48000",
            "-af", "highpass=f=70,loudnorm=I=-20:TP=-2:LRA=7", str(normalized),
        ], check=True)
        from df.enhance import enhance, init_df, load_audio, save_audio

        model, state, _ = init_df()
        audio, _ = load_audio(str(normalized), sr=state.sr())
        cleaned = enhance(model, state, audio, atten_lim_db=30)
        save_audio(str(output), cleaned, state.sr())
        print(f"Enhanced reference written to {output}", flush=True)
        return 0
    finally:
        normalized.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Reference enhancement failed: {error}", file=sys.stderr, flush=True)
        raise
