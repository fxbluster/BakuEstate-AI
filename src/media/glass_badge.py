"""
glass_badge.py - Floating Glassmorphic UI Badges for BakuEstate-AI.
Generates anti-aliased frosted-glass hero and CTA pills with modern architectural
typography (Bahnschrift / Segoe UI), rounded corners, and subtle borders.
Includes 4 Listing-Type Visual Archetypes (budget, luxury, villa, commercial),
optimized 2.5s hero timing, and mobile-calibrated specs line.
"""

import os
import re
import sys
import logging
from pathlib import Path
from typing import Dict, Any, Optional, Tuple, List
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


# Archetype Styling Configurations
ARCHETYPE_STYLES = {
    "budget": {
        "container_fill": (15, 30, 65, 224),       # Royal Cobalt acrylic rgba(15, 30, 65, 0.88)
        "container_outline": (255, 255, 255, 65),  # Clean subtle light border
        "price_color": (255, 255, 255, 255),       # Clean White price for high contrast
        "specs_color": (203, 213, 225, 240),       # Light slate
        "default_pills": [
            ("DAŞ BİNA", (16, 185, 129, 225)),     # Emerald
            ("İPOTEKAYA YARARLI", (59, 130, 246, 225)), # Cobalt Blue
        ]
    },
    "luxury": {
        "container_fill": (10, 15, 29, 230),       # Obsidian Slate rgba(10, 15, 29, 0.90)
        "container_outline": (245, 215, 145, 125), # Champagne Gold accent border
        "price_color": (245, 215, 145, 255),       # Champagne Gold
        "specs_color": (226, 232, 240, 240),       # Warm Pearl
        "default_pills": [
            ("PREMİUM DİZAYN", (217, 119, 6, 225)), # Amber Gold
            ("PANORAMİK", (6, 182, 212, 225)),     # Cyan
        ]
    },
    "villa": {
        "container_fill": (28, 25, 23, 225),       # Warm Terracotta / Sand rgba(28, 25, 23, 0.88)
        "container_outline": (217, 119, 6, 110),   # Warm Amber outline
        "price_color": (253, 230, 138, 255),       # Warm Sunlight
        "specs_color": (231, 229, 228, 240),       # Stone White
        "default_pills": [
            ("FİLTERLİ HOVUZ", (6, 182, 212, 225)), # Cyan
            ("6 SOT HƏYƏT", (21, 128, 61, 225)),   # Forest Olive
        ]
    },
    "commercial": {
        "container_fill": (15, 23, 42, 235),       # Deep Navy rgba(15, 23, 42, 0.92)
        "container_outline": (6, 182, 212, 140),   # Electric Cyan outline
        "price_color": (251, 191, 36, 255),       # Neon Gold / Amber
        "specs_color": (203, 213, 225, 240),       # Cyan-tinted Slate
        "default_pills": [
            ("GUR İNSAN AXINI", (225, 29, 72, 225)), # Signal Crimson
            ("İLLİK 10% ROI", (6, 182, 212, 225)), # Electric Cyan
        ]
    }
}


def create_hero_badge(
    listing: Dict[str, Any],
    output_path: Optional[Path] = None,
    width: int = 960,
    height: int = 240,
    archetype: str = "budget"
) -> Path:
    """
    Renders an ephemeral floating frosted-glass hero pill with 4 Visual Archetypes:
    - budget: Royal Cobalt & Fresh Emerald (Daş Bina, İpotekaya Yararlı)
    - luxury: Obsidian Slate & Champagne Gold (Premium Dizayn, Panoramik)
    - villa: Warm Terracotta Sand & Olive (Filterli Hovuz, 6 Sot Həyət)
    - commercial: Deep Navy & Electric Cyan (Gur İnsan Axını, İllik 10% ROI)
    """
    style_key = archetype.lower() if archetype.lower() in ARCHETYPE_STYLES else "budget"
    style = ARCHETYPE_STYLES[style_key]

    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1. Frosted Glass Container with Archetype Colors
    draw.rounded_rectangle(
        [0, 0, width, height],
        radius=36,
        fill=style["container_fill"],
        outline=style["container_outline"],
        width=2
    )

    # Fonts (Specs increased to 28pt for 6-inch phone screen legibility)
    font_price = get_best_font(size=46, bold=True)
    font_specs = get_best_font(size=28, bold=False)
    font_pill = get_best_font(size=19, bold=True)

    # 2. Status Pills (Top Row: y=26)
    x_cursor = 36
    pill_y = 26
    pill_h = 36

    has_kupca = listing.get("has_bill_of_sale", True)
    is_urgent = listing.get("is_urgent", False)

    # Determine custom or archetype pills
    rendered_pills: List[Tuple[str, Tuple[int, int, int, int]]] = []

    if is_urgent:
        rendered_pills.append(("TƏCİLİ SATIŞ", (225, 29, 72, 225)))

    if has_kupca:
        rendered_pills.append(("KUPÇALI", (16, 185, 129, 225)))

    # Add archetype-specific signature pills
    for pill_name, pill_color in style["default_pills"]:
        if len(rendered_pills) < 3 and not any(p[0] == pill_name for p in rendered_pills):
            rendered_pills.append((pill_name, pill_color))

    for pill_text, fill_color in rendered_pills:
        bbox = draw.textbbox((0, 0), pill_text, font=font_pill)
        text_w = bbox[2] - bbox[0]
        pill_w = max(110, text_w + 28)

        draw.rounded_rectangle(
            [x_cursor, pill_y, x_cursor + pill_w, pill_y + pill_h],
            radius=18,
            fill=fill_color
        )
        draw.text((x_cursor + 14, pill_y + 7), pill_text, font=font_pill, fill=(255, 255, 255, 255))
        x_cursor += pill_w + 12

    # 3. Price Display (Middle Row: y=86)
    price = listing.get("price")
    curr = listing.get("currency") or "AZN"
    try:
        num_price = float(price) if price is not None else 0.0
        formatted_price = f"{int(num_price):,}".replace(",", " ") if num_price > 0 else "Münasib Qiymət"
    except (ValueError, TypeError):
        formatted_price = "Münasib Qiymət"

    price_str = f"{formatted_price} {curr}"
    draw.text((36, 86), price_str, font=font_price, fill=style["price_color"])

    # 4. Specs Line (Bottom Row: y=166, font size 28pt)
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

    draw.text((36, 166), specs_display, font=font_specs, fill=style["specs_color"])

    # Save output
    if not output_path:
        output_path = Path("data/output/hero_badge.png")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(output_path), "PNG")
    logger.info(f"Created {archetype} glassmorphic hero badge: {output_path} ({width}x{height})")
    return output_path


def create_cta_badge(
    listing: Dict[str, Any],
    output_path: Optional[Path] = None,
    width: int = 920,
    height: int = 150
) -> Path:
    """
    Renders a sleek, mobile safe-zone Call-to-Action badge for the final 3.5 seconds.
    Positioned at y=1380 to keep the bottom 390px free from TikTok/Reels UI button collisions.
    """
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle(
        [0, 0, width, height],
        radius=30,
        fill=(15, 23, 42, 220),
        outline=(16, 185, 129, 130),
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


def create_bottom_scrim_png(
    output_path: Optional[Path] = None,
    width: int = 1080,
    height: int = 1920,
    scrim_start_y: int = 1180,
    max_alpha: int = 140
) -> Path:
    """
    Generates a subtle vertical gradient scrim from transparent (y=1180) to dark (y=1920, alpha~55%).
    Ensures white kinetic subtitles and CTA badges are 100% readable over bright sunlit windows
    and white marble floors without requiring solid rectangular boxes.
    """
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    scrim_height = height - scrim_start_y

    for y in range(scrim_height):
        # Smooth quadratic ease-in gradient
        progress = y / float(scrim_height)
        alpha = int(max_alpha * (progress ** 1.3))
        # Draw a horizontal line of dark scrim
        img.paste((8, 12, 20, alpha), [0, scrim_start_y + y, width, scrim_start_y + y + 1])

    if not output_path:
        output_path = Path("data/output/bottom_scrim.png")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(output_path), "PNG")
    logger.info(f"Created bottom scrim gradient: {output_path}")
    return output_path


def get_hero_overlay_filter(
    badge_path: Path,
    video_width: int = 1080,
    video_height: int = 1920,
    start_time: float = 0.2,
    end_time: float = 2.5,
    target_y: int = 160
) -> Tuple[str, str]:
    """
    Returns (filter_str, escaped_path) for FFmpeg with optimized 2.5s hero timing:
    - Smooth slide-down in first 0.35s
    - Floats proudly for ~2.0s to hook viewer attention
    - Dissolves / disappears cleanly at 2.5s into the apartment walkthrough
    """
    posix_path = str(badge_path.resolve()).replace("\\", "/")
    if ":" in posix_path:
        drive, rest = posix_path.split(":", 1)
        escaped_path = f"{drive}\\:{rest}"
    else:
        escaped_path = posix_path

    # Smooth slide-down: from (target_y - 80) to target_y in 0.35s
    y_expr = f"'if(lt(t,{start_time + 0.35:.2f}), {target_y}-(({start_time + 0.35:.2f}-t)/0.35)*80, {target_y})'"
    overlay_filter = (
        f"overlay=x=(W-w)/2:y={y_expr}:enable='between(t,{start_time:.2f},{end_time:.2f})':format=auto"
    )
    return overlay_filter, escaped_path
