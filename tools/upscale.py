#!/usr/bin/env python3
"""
upscale.py — Fast Neural Super-Resolution for Apple Silicon (Metal/MPS).
Uses 4x-UltraSharp via Spandrel.
"""

import argparse
import sys
import time
from pathlib import Path
from PIL import Image
import numpy as np
import torch
from spandrel import ModelLoader

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = ROOT / "tools" / "models" / "4x-UltraSharp.pth"


def get_device() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    elif torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def ensure_model(model_path: Path) -> Path:
    if not model_path.exists():
        model_path.parent.mkdir(parents=True, exist_ok=True)
        url = "https://huggingface.co/lokCX/4x-Ultrasharp/resolve/main/4x-UltraSharp.pth"
        print(f"Downloading 4x-UltraSharp weights to {model_path}...")
        import urllib.request
        urllib.request.urlretrieve(url, str(model_path))
    return model_path


def upscale_image(
    input_path: Path,
    output_path: Path,
    target_width: int = 1920,
    target_height: int = 1080,
    model_path: Path = DEFAULT_MODEL,
) -> bool:
    device = get_device()
    model_path = ensure_model(model_path)
    print(f"Loading upscaler: {model_path.name} on {device}...")
    t0 = time.time()
    loader = ModelLoader()
    model = loader.load_from_file(str(model_path))
    model = model.to(device)
    model.eval()

    img = Image.open(input_path).convert("RGB")
    orig_w, orig_h = img.size
    print(f"Input image: {orig_w}x{orig_h} -> Target: {target_width}x{target_height}")

    # Convert to tensor [1, C, H, W], normalized 0-1
    arr = np.array(img).astype(np.float32) / 255.0
    tensor = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0).to(device)

    t_inf = time.time()
    with torch.no_grad():
        out_tensor = model(tensor)
    inf_time = time.time() - t_inf

    # Back to PIL
    out_arr = out_tensor.squeeze(0).permute(1, 2, 0).cpu().clamp(0, 1).numpy()
    out_arr = (out_arr * 255.0).round().astype(np.uint8)
    up_img = Image.fromarray(out_arr)

    # If target dimensions specified and different from native 4x, downsample with Lanczos
    if target_width and target_height and (up_img.width != target_width or up_img.height != target_height):
        final_img = up_img.resize((target_width, target_height), Image.Resampling.LANCZOS)
    else:
        final_img = up_img

    output_path.parent.mkdir(parents=True, exist_ok=True)
    final_img.save(output_path, quality=95)
    total_time = time.time() - t0

    print(f"✓ Super-resolution completed in {total_time:.2f}s (inference: {inf_time:.2f}s)!")
    print(f"Saved enhanced 1080p asset to: {output_path}")
    return True


def main():
    parser = argparse.ArgumentParser(description="Neural super-resolution upscaler for Apple Silicon.")
    parser.add_argument("input", type=Path, help="Path to input image")
    parser.add_argument("--output", "-o", type=Path, default=None, help="Output path")
    parser.add_argument("--width", type=int, default=1920, help="Target width (default: 1920)")
    parser.add_argument("--height", type=int, default=1080, help="Target height (default: 1080)")
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL, help="Path to .pth upscaler model")
    args = parser.parse_args()

    out = args.output or args.input.with_name(f"{args.input.stem}_1080p.png")
    success = upscale_image(args.input, out, args.width, args.height, args.model)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
