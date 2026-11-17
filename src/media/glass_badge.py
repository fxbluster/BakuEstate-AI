"""
glass_badge.py - Floating Glassmorphic UI Badges for BakuEstate-AI.
Generates anti-aliased frosted-glass hero and CTA pills with modern architectural
typography (Bahnschrift / Segoe UI), rounded corners, and subtle borders.
Replaces the old rigid rectangular 250px opaque card with an ephemeral luxury aesthetic.
"""

import os
import re
import sys
import logging
from pathlib import Path
from typing import Dict, Any, Optional, Tuple
from PIL import Image, ImageDraw, ImageFont

logger = logging.getLogger("glass_badge")

def get_best_font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    """Finds best available architectural font with Azerbaijani Latin support."""
    font_candidates = [
        "C:/Windows/Fonts/bahnschrift.ttf",
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    for path in font_candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def create_hero_badge(
    listing: Dict[str, Any],
    output_path: Optional[Path] = None,
    width: int = 960,
    height: int = 240
) -> Path:
    """
    Renders an ephemeral floating frosted-glass hero pill for the video's first 3.5s.
    
    Includes:
    - Frosted dark translucent backdrop with 36px curved corners
    - Subtle 1.5px light border (rgba(255, 255, 255, 0.22))
    - Soft Status pills: 'TƏCİLİ SATIŞ' (rose crimson) & 'KUPÇALI' (emerald green)
    - Champagne Gold bold price line
    - Sleek specs line (location, rooms, area)
    """
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1. Frosted Glass Container (Dark Slate Translucent rgba(15, 23, 42, 0.78))
    # Border: subtle light translucent stroke rgba(255, 255, 255, 0.22)
    draw.rounded_rectangle(
        [0, 0, width, height],
        radius=36,
        fill=(15, 23, 42, 198),
        outline=(255, 255, 255, 56),
        width=2
    )

    # Fonts
    font_price = get_best_font(size=46, bold=True)
    font_specs = get_best_font(size=25, bold=False)
    font_pill = get_best_font(size=20, bold=True)

    # 2. Status Pills (Top Row: y=28)
    has_kupca = listing.get("has_bill_of_sale", True)
    is_urgent = listing.get("is_urgent", True)

    x_cursor = 38
    pill_y = 26
    pill_h = 36

    if is_urgent:
        pill_w = 175
        draw.rounded_rectangle(
            [x_cursor, pill_y, x_cursor + pill_w, pill_y + pill_h],
            radius=18,
            fill=(225, 29, 72, 225)  # Rose Crimson
        )
        draw.text((x_cursor + 20, pill_y + 6), "TƏCİLİ SATIŞ", font=font_pill, fill=(255, 255, 255, 255))
        x_cursor += pill_w + 14

    if has_kupca:
        pill_w = 145
        draw.rounded_rectangle(
            [x_cursor, pill_y, x_cursor + pill_w, pill_y + pill_h],
            radius=18,
            fill=(16, 185, 129, 225)  # Emerald Green
        )
        draw.text((x_cursor + 22, pill_y + 6), "KUPÇALI", font=font_pill, fill=(255, 255, 255, 255))
        x_cursor += pill_w + 14

    # Direct owner tag if applicable
    if listing.get("is_owner", True):
        pill_w = 170
        draw.rounded_rectangle(
            [x_cursor, pill_y, x_cursor + pill_w, pill_y + pill_h],
            radius=18,
            fill=(99, 102, 241, 200)  # Indigo
        )
        draw.text((x_cursor + 18, pill_y + 6), "SAHİBİNDƏN", font=font_pill, fill=(255, 255, 255, 255))

    # 3. Price Display (Middle Row: y=86)
    price = listing.get("price")
    curr = listing.get("currency") or "AZN"
    try:
        num_price = float(price) if price is not None else 0.0
        formatted_price = f"{int(num_price):,}".replace(",", " ") if num_price > 0 else "Münasib Qiymət"
    except (ValueError, TypeError):
        formatted_price = "Münasib Qiymət"

    price_str = f"{formatted_price} {curr}"
    # Champagne Gold / Warm Sunlight: RGB(245, 215, 145)
    draw.text((38, 86), price_str, font=font_price, fill=(245, 215, 145, 255))

    # 4. Specs Line (Bottom Row: y=168)
    raw_loc = listing.get("location") or listing.get("address") or "Bakı şəhəri"
    loc_clean = re.sub(r'\bq\.(?=\s|$|[,\.!])', 'qəs.', raw_loc, flags=re.IGNORECASE).strip()
    loc_clean = re.sub(r'\bm\.(?=\s|$|[,\.!])', 'm.', loc_clean, flags=re.IGNORECASE).strip()
    loc_clean = re.sub(r'\bküç\.(?=\s|$|[,\.!])', 'küç.', loc_clean, flags=re.IGNORECASE).strip()

    rooms = listing.get("rooms")
    area = listing.get("area")
    specs_parts = [loc_clean]
    if rooms:
        specs_parts.append(f"{rooms} otaq")
    if area:
        try:
            specs_parts.append(f"{int(float(area))} m²")
        except Exception:
            specs_parts.append(f"{area} m²")
    specs_display = "  •  ".join(specs_parts)

    draw.text((38, 168), specs_display, font=font_specs, fill=(203, 213, 225, 235))

    # Save output
    if not output_path:
        output_path = Path("data/output/hero_badge.png")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(output_path), "PNG")
    logger.info(f"Created glassmorphic hero badge: {output_path} ({width}x{height})")
    return output_path


def create_cta_badge(
    listing: Dict[str, Any],
    output_path: Optional[Path] = None,
    width: int = 920,
    height: int = 150
) -> Path:
    """
    Renders a sleek, mobile safe-zone Call-to-Action badge for the final 4 seconds.
    Positioned in the middle-safe zone (y=1380) so it is NEVER cut off by TikTok/Reels UI.
    """
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle(
        [0, 0, width, height],
        radius=30,
        fill=(15, 23, 42, 210),
        outline=(16, 185, 129, 120),
        width=2
    )

    font_top = get_best_font(size=23, bold=True)
    font_phone = get_best_font(size=34, bold=True)

    phone = listing.get("owner_phone") or listing.get("phone") or ""
    if phone:
        line2 = f"ƏLAQƏ / WHATSAPP: {phone}"
    else:
        line2 = "ƏLAQƏ / WHATSAPP ÜÇÜN DM YAZIN"
    line1 = "BİRBAŞA SAHİBİNDƏN  •  KOMİSSİYASIZ"

    # Center text
    bbox1 = draw.textbbox((0, 0), line1, font=font_top)
    w1 = bbox1[2] - bbox1[0]
    draw.text(((width - w1) // 2, 28), line1, font=font_top, fill=(245, 215, 145, 255))

    bbox2 = draw.textbbox((0, 0), line2, font=font_phone)
    w2 = bbox2[2] - bbox2[0]
    draw.text(((width - w2) // 2, 74), line2, font=font_phone, fill=(255, 255, 255, 255))

    if not output_path:
        output_path = Path("data/output/cta_badge.png")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(output_path), "PNG")
    logger.info(f"Created glassmorphic CTA badge: {output_path}")
    return output_path


def get_hero_overlay_filter(
    badge_path: Path,
    video_width: int = 1080,
    video_height: int = 1920,
    start_time: float = 0.2,
    end_time: float = 3.6,
    target_y: int = 160
) -> Tuple[str, str]:
    """
    Returns (filter_str, escaped_path) for FFmpeg to animate the hero badge:
    - Smooth slide-down in first 0.3s
    - Floats proudly for ~3.1s to hook the viewer
    - Dissolves / disappears cleanly into the apartment tour
    """
    posix_path = str(badge_path.resolve()).replace("\\", "/")
    if ":" in posix_path:
        drive, rest = posix_path.split(":", 1)
        escaped_path = f"{drive}\\:{rest}"
    else:
        escaped_path = posix_path

    # Smooth entrance: slide down from y=(target_y - 80) to target_y in 0.35s
    y_expr = f"'if(lt(t,{start_time + 0.35:.2f}), {target_y}-(({start_time + 0.35:.2f}-t)/0.35)*80, {target_y})'"
    overlay_filter = (
        f"overlay=x=(W-w)/2:y={y_expr}:enable='between(t,{start_time:.2f},{end_time:.2f})':format=auto"
    )
    return overlay_filter, escaped_path
