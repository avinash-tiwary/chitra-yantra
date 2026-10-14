import math
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

OUTPUT_DIR = Path(__file__).resolve().parents[1] / "public"

# SVG Favicon Definition
SVG_CONTENT = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <defs>
    <linearGradient id="cy-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#192230"/>
      <stop offset="100%" stop-color="#0b0e14"/>
    </linearGradient>
    <linearGradient id="cy-gold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f8d68d"/>
      <stop offset="60%" stop-color="#dfa34b"/>
      <stop offset="100%" stop-color="#c6852a"/>
    </linearGradient>
    <linearGradient id="cy-gold-inner" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fff1d0"/>
      <stop offset="100%" stop-color="#dfa34b"/>
    </linearGradient>
    <filter id="cy-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="0" stdDeviation="0.8" flood-color="#dfa34b" flood-opacity="0.35"/>
    </filter>
  </defs>
  <!-- Base Squircle -->
  <rect x="1.5" y="1.5" width="29" height="29" rx="6.5" fill="url(#cy-bg)" stroke="#2d3748" stroke-width="1"/>
  <!-- Inner Subtle Accent Border -->
  <rect x="2.5" y="2.5" width="27" height="27" rx="5.5" fill="none" stroke="#e8a84c" stroke-width="0.5" stroke-opacity="0.2"/>
  <!-- Yantra Diamond Motif (Rotated 45° at center 16, 16) -->
  <g transform="rotate(45 16 16)" filter="url(#cy-glow)">
    <!-- Outer Yantra Diamond Frame -->
    <rect x="7" y="7" width="18" height="18" rx="1.6" fill="none" stroke="url(#cy-gold)" stroke-width="1.8"/>
    <!-- Middle Concentric Diamond Frame -->
    <rect x="10.25" y="10.25" width="11.5" height="11.5" rx="0.8" fill="none" stroke="#f0ce8c" stroke-width="1.2" stroke-opacity="0.85"/>
    <!-- Core Sacred Diamond (Bindu) -->
    <rect x="13.5" y="13.5" width="5" height="5" rx="0.5" fill="url(#cy-gold-inner)"/>
  </g>
</svg>
'''

def render_raster_icon(size):
    # Supersample at 8x for buttery smooth antialiasing
    scale = 8
    canvas_size = size * scale
    img = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    pad = 1.5 * scale * (size / 32.0)
    radius = 6.5 * scale * (size / 32.0)
    
    # Rounded rect background
    draw.rounded_rectangle(
        [pad, pad, canvas_size - pad, canvas_size - pad],
        radius=radius,
        fill=(12, 16, 22, 255),
        outline=(45, 55, 72, 255),
        width=max(1, int(1.0 * scale * (size / 32.0)))
    )
    
    # Accent ring
    inner_pad = 2.5 * scale * (size / 32.0)
    inner_radius = 5.5 * scale * (size / 32.0)
    if size >= 32:
        draw.rounded_rectangle(
            [inner_pad, inner_pad, canvas_size - inner_pad, canvas_size - inner_pad],
            radius=inner_radius,
            fill=None,
            outline=(223, 163, 75, 45),
            width=max(1, int(0.5 * scale * (size / 32.0)))
        )
        
    cx, cy = canvas_size / 2.0, canvas_size / 2.0
    
    def diamond_poly(half_diag):
        return [
            (cx, cy - half_diag),
            (cx + half_diag, cy),
            (cx, cy + half_diag),
            (cx - half_diag, cy)
        ]
        
    # Outer diamond: width 18 at 32 -> half_diag = 18 * sqrt(2)/2 = 12.7279
    outer_diag = 12.7279 * scale * (size / 32.0)
    outer_w = max(1, int(1.8 * scale * (size / 32.0)))
    draw.polygon(diamond_poly(outer_diag), outline=(238, 185, 96, 255), width=outer_w)
    
    # Middle diamond: width 11.5 at 32 -> half_diag = 8.1317
    mid_diag = 8.1317 * scale * (size / 32.0)
    mid_w = max(1, int(1.2 * scale * (size / 32.0)))
    draw.polygon(diamond_poly(mid_diag), outline=(245, 214, 153, 220), width=mid_w)
    
    # Inner diamond: width 5 at 32 -> half_diag = 3.5355
    inner_diag = 3.5355 * scale * (size / 32.0)
    draw.polygon(diamond_poly(inner_diag), fill=(248, 220, 155, 255))
    
    return img.resize((size, size), Image.Resampling.LANCZOS)

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # 1. Write SVG
    svg_path = os.path.join(OUTPUT_DIR, "favicon.svg")
    with open(svg_path, "w", encoding="utf-8") as f:
        f.write(SVG_CONTENT.strip() + "\n")
    print(f"Written: {svg_path}")
    
    # 2. Render PNGs
    sizes = {
        "favicon.png": 32,
        "favicon-32x32.png": 32,
        "favicon-16x16.png": 16,
        "apple-touch-icon.png": 180,
    }
    
    images = {}
    for filename, sz in sizes.items():
        img = render_raster_icon(sz)
        images[sz] = img
        out_path = os.path.join(OUTPUT_DIR, filename)
        img.save(out_path, format="PNG")
        print(f"Written: {out_path} ({sz}x{sz})")
        
    # 3. Multi-resolution ICO
    ico_path = os.path.join(OUTPUT_DIR, "favicon.ico")
    img_48 = render_raster_icon(48)
    # PIL saves multi-size ICO using append_images
    img_48.save(ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"Written: {ico_path} (16x16, 32x32, 48x48)")

if __name__ == "__main__":
    main()
