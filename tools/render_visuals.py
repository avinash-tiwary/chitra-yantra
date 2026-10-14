#!/usr/bin/env python3
"""
render_visuals.py — Standalone visual asset generator for Chitra Yantra pipeline.

Runs 100% locally on Apple Silicon (via native MLX / mflux).
Zero external backend servers or ComfyUI dependencies required.

Usage:
    # Full project batch (integrated with Chitra Yantra):
    python tools/render_visuals.py channels/example-channel/videos/2026-09-13_example-topic-university/

    # Single-prompt test mode:
    python tools/render_visuals.py --prompt "Ancient Example Topic monastery at dawn, 16:9" --output tests/example-topic.png
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MFLUX_BIN = ROOT / ".venv" / "bin" / "mflux-generate"

DEFAULT_MODEL = "filipstrand/Z-Image-Turbo-mflux-4bit"
DEFAULT_BASE_MODEL = "z-image-turbo"
DEFAULT_STEPS = 8
DEFAULT_WIDTH = 1280
DEFAULT_HEIGHT = 720


def find_latest_asset_plan(project_dir: Path) -> Path | None:
    """Locate the highest versioned asset plan JSON or markdown in 04_visuals."""
    plans_dir = project_dir / "04_visuals" / "plans"
    if plans_dir.is_dir():
        json_plans = sorted(plans_dir.glob("asset_plan_v*.json"), reverse=True)
        if json_plans:
            return json_plans[0]
        md_plans = sorted(plans_dir.glob("asset_plan_v*.md"), reverse=True)
        if md_plans:
            return md_plans[0]

    prompts_dir = project_dir / "04_visuals" / "prompts"
    if prompts_dir.is_dir():
        json_prompts = sorted(prompts_dir.glob("*.json"), reverse=True)
        if json_prompts:
            return json_prompts[0]
        md_prompts = sorted(prompts_dir.glob("*.md"), reverse=True)
        if md_prompts:
            return md_prompts[0]

    return None


def get_mflux_binary(model_name: str) -> str:
    if "z-image" in model_name.lower():
        turbo_bin = ROOT / ".venv" / "bin" / "mflux-generate-z-image-turbo"
        if turbo_bin.exists():
            return str(turbo_bin)
    flux_bin = ROOT / ".venv" / "bin" / "mflux-generate"
    return str(flux_bin if flux_bin.exists() else "mflux-generate")


def generate_single_image(
    prompt: str,
    output_path: Path,
    model: str = DEFAULT_MODEL,
    base_model: str = DEFAULT_BASE_MODEL,
    steps: int = DEFAULT_STEPS,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
) -> bool:
    """Generate an image using local mflux CLI."""
    binary = get_mflux_binary(model)
    cmd = [
        binary,
        "--model", model,
        "--prompt", prompt,
        "--output", str(output_path),
        "--steps", str(steps),
        "--width", str(width),
        "--height", str(height),
    ]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
        elapsed = time.time() - t0
        print(f"    ✓ Generated in {elapsed:.1f}s -> {output_path.name}")
        return True
    except subprocess.CalledProcessError as e:
        print(f"    ✗ Generation failed: {e.stderr[:200] if e.stderr else e}", file=sys.stderr)
        return False


def run_upscale(input_path: Path, output_path: Path, width: int = 1920, height: int = 1080) -> bool:
    """Upscale image using 4x-UltraSharp (PyTorch MPS / Metal)."""
    try:
        sys.path.insert(0, str(ROOT / "tools"))
        from upscale import upscale_image
        return upscale_image(input_path, output_path, target_width=width, target_height=height)
    except Exception:
        python_bin = ROOT / ".venv" / "bin" / "python"
        if not python_bin.exists():
            python_bin = Path(sys.executable)
        cmd = [
            str(python_bin),
            str(ROOT / "tools" / "upscale.py"),
            str(input_path),
            "-o", str(output_path),
            "--width", str(width),
            "--height", str(height),
        ]
        try:
            res = subprocess.run(cmd, check=True)
            return res.returncode == 0
        except Exception as err:
            print(f"    ✗ Upscale failed for {input_path.name}: {err}", file=sys.stderr)
            return False


def process_project(
    project_dir: Path,
    model: str = DEFAULT_MODEL,
    base_model: str = DEFAULT_BASE_MODEL,
    steps: int = DEFAULT_STEPS,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    force: bool = False,
    limit: int = 0,
    asset_id: str | None = None,
    upscale_selected: bool = False,
    upscale_asset: str | None = None,
) -> int:
    """Batch-render or selectively upscale visual assets for a project."""
    plan_file = find_latest_asset_plan(project_dir)
    if not plan_file:
        print(f"Error: No asset plan found in {project_dir / '04_visuals'}. Run asset_extractor.py first.", file=sys.stderr)
        return 1

    print(f"Reading asset plan: {plan_file.relative_to(ROOT)}")
    renders_dir = project_dir / "04_visuals" / "renders"
    renders_dir.mkdir(parents=True, exist_ok=True)

    try:
        plan_data = json.loads(plan_file.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"Error parsing {plan_file}: {e}", file=sys.stderr)
        return 1

    if not isinstance(plan_data, list):
        print(f"Unexpected format in {plan_file}: expected list of items", file=sys.stderr)
        return 1

    # Mode 1: Selective upscaling of approved/selected assets only
    if upscale_selected or upscale_asset:
        upscaled_count = 0
        target_ids = [upscale_asset] if upscale_asset else None
        print(f"Starting selective 1080p neural upscaling for {'asset ' + upscale_asset if upscale_asset else 'approved assets'}...")
        for item in plan_data:
            item_id = item.get("id", "")
            if target_ids and item_id not in target_ids:
                continue
            is_approved = item.get("approvalStatus") == "approved" or item.get("selected") is True
            if not target_ids and not is_approved:
                continue

            dest_file = renders_dir / f"{item_id}.png"
            if not dest_file.exists() or dest_file.stat().st_size < 1000:
                print(f"    ↳ Skipping {item_id}: source render not found at {dest_file.name}")
                continue

            if item.get("upscaled") is True and item.get("resolution") == "1920x1080" and not force:
                print(f"    ↳ Already upscaled to 1080p -> skipping {item_id}")
                continue

            print(f"Upscaling [{item_id}] to 1080p Full HD (1920x1080)...")
            success = run_upscale(dest_file, dest_file, width=1920, height=1080)
            if success:
                item["upscaled"] = True
                item["resolution"] = "1920x1080"
                item["generatedPath"] = str(dest_file.relative_to(project_dir))
                upscaled_count += 1

        try:
            plan_file.write_text(json.dumps(plan_data, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"Updated asset plan with upscale metadata: {plan_file.name}")
        except Exception as e:
            print(f"Warning: could not update plan file: {e}")

        print(f"\nSelective Upscale Complete: {upscaled_count} asset(s) enhanced to 1080p.")
        return 0

    # Mode 2: Generation of assets (single asset or batch)
    total = len(plan_data)
    processed = 0
    generated = 0
    skipped = 0

    if asset_id:
        print(f"Targeting single asset generation: {asset_id}")
    else:
        print(f"Starting visual production: {total} total assets scheduled...")

    for idx, item in enumerate(plan_data, 1):
        item_id = item.get("id", f"ASSET_{idx:03d}")
        if asset_id and item_id != asset_id:
            continue

        if limit > 0 and generated >= limit:
            print(f"Reached limit of {limit} generations.")
            break

        item_type = (item.get("type") or "GEN").upper()
        prompt = item.get("prompt") or item.get("description", "")
        dest_file = renders_dir / f"{item_id}.png"

        print(f"[{idx}/{total}] {item_id} ({item_type}): {item.get('description', '')[:55]}...")

        if dest_file.exists() and dest_file.stat().st_size > 1000 and not force:
            print(f"    ↳ Already exists -> skipping ({dest_file.name})")
            item["generatedPath"] = str(dest_file.relative_to(project_dir))
            skipped += 1
            continue

        if item_type in ("GEN", "PHOTO", "MAP"):
            success = generate_single_image(
                prompt=prompt,
                output_path=dest_file,
                model=model,
                base_model=base_model,
                steps=steps,
                width=width,
                height=height,
            )
            if success:
                item["generatedPath"] = str(dest_file.relative_to(project_dir))
                item["resolution"] = f"{width}x{height}"
                item["upscaled"] = False
                generated += 1
            else:
                print(f"    ↳ Failed to render {item_id}")
        else:
            print(f"    ↳ Skipped non-generative cue type: {item_type}")

        processed += 1

    # Save updated plan
    try:
        plan_file.write_text(json.dumps(plan_data, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Updated asset plan with output paths: {plan_file.name}")
    except Exception as e:
        print(f"Warning: could not update plan file: {e}")

    print(f"\nVisual Stage Complete: {generated} rendered, {skipped} skipped, {total} total assets.")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Standalone local visual generator for Chitra Yantra (Apple Silicon MLX).")
    parser.add_argument("project_dir", nargs="?", type=Path, help="Path to project directory (e.g. channels/example-channel/videos/slug)")
    parser.add_argument("--prompt", help="Single prompt generation mode")
    parser.add_argument("--output", default="output.png", help="Output path for single prompt mode")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Model name or HuggingFace repo (default: filipstrand/Z-Image-Turbo-mflux-4bit)")
    parser.add_argument("--base-model", default=DEFAULT_BASE_MODEL, help="Base model architecture (default: z-image-turbo)")
    parser.add_argument("--steps", type=int, default=DEFAULT_STEPS, help=f"Inference steps (default: {DEFAULT_STEPS})")
    parser.add_argument("--width", type=int, default=DEFAULT_WIDTH, help=f"Width (default: {DEFAULT_WIDTH})")
    parser.add_argument("--height", type=int, default=DEFAULT_HEIGHT, help=f"Height (default: {DEFAULT_HEIGHT})")
    parser.add_argument("--force", action="store_true", help="Re-render even if image already exists")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of assets to render (0 for all)")
    parser.add_argument("--asset-id", help="Render only a specific asset ID from the plan")
    parser.add_argument("--upscale-selected", action="store_true", help="Upscale only approved/selected assets in the plan to 1080p")
    parser.add_argument("--upscale-asset", help="Upscale a single specific asset ID to 1080p")

    args = parser.parse_args()

    if args.prompt:
        out_path = Path(args.output).resolve()
        print(f"Generating single image to: {out_path}")
        success = generate_single_image(
            prompt=args.prompt,
            output_path=out_path,
            model=args.model,
            base_model=args.base_model,
            steps=args.steps,
            width=args.width,
            height=args.height,
        )
        return 0 if success else 1

    if not args.project_dir:
        parser.print_help()
        return 1

    project_dir = args.project_dir.resolve()
    return process_project(
        project_dir=project_dir,
        model=args.model,
        base_model=args.base_model,
        steps=args.steps,
        width=args.width,
        height=args.height,
        force=args.force,
        limit=args.limit,
        asset_id=args.asset_id,
        upscale_selected=args.upscale_selected,
        upscale_asset=args.upscale_asset,
    )


if __name__ == "__main__":
    sys.exit(main())
