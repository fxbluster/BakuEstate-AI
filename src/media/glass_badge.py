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


def _draw_pill_tag(
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    text: str,
    font: Any,
    bg_rgba: Tuple[int, int, int, int],
    text_rgba: Tuple[int, int, int, int] = (255, 255, 255, 255),
    pad_x: int = 16,
    pad_y: int = 7,
) -> int:
    """Draws a crisp rounded pill tag and returns its right x coordinate."""
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    pw = tw + pad_x * 2
    ph = th + pad_y * 2
    draw.rounded_rectangle([x, y, x + pw, y + ph], radius=ph // 2, fill=bg_rgba)
    draw.text((x + pad_x, y + pad_y - bbox[1]), text, font=font, fill=text_rgba)
    return x + pw


def create_hero_badge(
    listing: Dict[str, Any],
    output_path: Optional[Path] = None,
    width: int = 940,
    height: int = 280,
    archetype: str = "budget",
    hook_text: Optional[str] = None,
) -> Path:
    """
    Renders a bold, high-contrast scroll-stopping editorial intro card:
    - Dark frosted glass card with vibrant archetype accent border & left bar
    - Colored pill badges (TƏCİLİ, KUPÇALI, archetype highlight)
    - Giant bold price, concise location/specs, and punchy 1-line hook headline
    """
    style_key = archetype.lower() if archetype.lower() in ARCHETYPE_STYLES else "budget"
    style = ARCHETYPE_STYLES[style_key]

    accent_map = {
        "budget": (255, 212, 59, 255),      # Vibrant Gold
        "luxury": (245, 215, 145, 255),     # Champagne Gold
        "villa": (52, 211, 153, 255),       # Emerald Mint
        "commercial": (56, 189, 248, 255),  # Sky Cyan
    }
    accent_color = accent_map.get(style_key, (255, 212, 59, 255))
    scale = min(1.0, height / 260.0) if height < 240 else 1.0

    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1. High-contrast Frosted Dark Glass Card
    draw.rounded_rectangle(
        [0, 0, width - 1, height - 1],
        radius=24,
        fill=(10, 14, 24, 215),
        outline=(accent_color[0], accent_color[1], accent_color[2], 145),
        width=2,
    )

    # Vertical architectural accent bar on the left
    bar_pad_y = max(18, int(height * 0.11))
    draw.rounded_rectangle(
        [20, bar_pad_y, 28, height - bar_pad_y],
        radius=4,
        fill=accent_color,
    )

    font_tag = get_best_font(size=max(16, int(20 * scale)), bold=True)
    font_price = get_best_font(size=max(38, int(64 * scale)), bold=True)
    font_specs = get_best_font(size=max(22, int(30 * scale)), bold=True)
    font_hook = get_best_font(size=max(18, int(25 * scale)), bold=False)

    # 2. Colored Pill Badges Row
    has_kupca = bool(listing.get("has_bill_of_sale", False))
    is_urgent = bool(listing.get("is_urgent", False))
    pill_defs: List[Tuple[str, Tuple[int, int, int, int], Tuple[int, int, int, int]]] = []
    if is_urgent:
        pill_defs.append(("TƏCİLİ SATIŞ", (220, 38, 38, 235), (255, 255, 255, 255)))
    if has_kupca:
        pill_defs.append(("KUPÇALI", (16, 185, 129, 230), (255, 255, 255, 255)))
    for pill_name, _ in style["default_pills"]:
        if len(pill_defs) < 3 and all(p[0] != pill_name for p in pill_defs):
            pill_defs.append((
                pill_name,
                (accent_color[0], accent_color[1], accent_color[2], 235),
                (15, 23, 42, 255),
            ))

    x_text = 48
    y_tag = max(16, int(height * 0.09))
    cur_x = x_text
    for p_label, p_bg, p_fg in pill_defs:
        cur_x = _draw_pill_tag(
            draw, cur_x, y_tag, p_label, font_tag, p_bg, p_fg,
            pad_x=max(10, int(14 * scale)), pad_y=max(4, int(6 * scale)),
        ) + 12

    # 3. Giant Bold Price
    price = listing.get("price")
    curr = listing.get("currency") or "AZN"
    try:
        num_price = float(price) if price is not None else 0.0
        formatted_price = f"{int(num_price):,}".replace(",", " ") if num_price > 0 else "Münasib Qiymət"
    except (ValueError, TypeError):
        formatted_price = "Münasib Qiymət"

    price_str = f"{formatted_price} {curr}"
    y_price = max(54, int(height * 0.27))
    draw.text((x_text, y_price), price_str, font=font_price, fill=(255, 255, 255, 255))

    # 4. Clean Location & Specs Line
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
    specs_display = "  ·  ".join(specs_parts)

    y_specs = max(106, int(height * 0.56))
    draw.text((x_text, y_specs), specs_display, font=font_specs, fill=accent_color)

    # 5. Punchy Hook Headline (for tall intro cards)
    if height >= 230:
        default_hooks = {
            "luxury": "Premium təmirli, eksklüziv yaşayış fürsəti!",
            "villa": "Geniş həyətli, tam hazır xüsusi mülk!",
            "commercial": "Yüksək gəlirli hazır obyekt təklifi!",
            "budget": "Əla yerləşmə və sərfəli qiymət fürsəti!",
        }
        resolved_hook = (hook_text or "").strip()
        if not resolved_hook:
            ab_meta = listing.get("ab_metadata") if isinstance(listing.get("ab_metadata"), dict) else {}
            vp = ab_meta.get("visual_profile") if isinstance(ab_meta.get("visual_profile"), dict) else {}
            resolved_hook = str(vp.get("hook_sentence_az") or "").strip()
        if not resolved_hook:
            resolved_hook = default_hooks.get(style_key, default_hooks["budget"])
        if len(resolved_hook) > 64:
            resolved_hook = resolved_hook[:61].rstrip() + "..."
        y_hook = int(height * 0.76)
        draw.text((x_text, y_hook), resolved_hook, font=font_hook, fill=(226, 232, 240, 245))

    if not output_path:
        output_path = Path("data/output/hero_badge.png")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(output_path), "PNG")
    logger.info(f"Created {archetype} editorial hero card: {output_path} ({width}x{height})")
    return output_path


def create_persistent_top_pill(
    listing: Dict[str, Any],
    output_path: Optional[Path] = None,
    width: int = 840,
    height: int = 60,
    archetype: str = "budget",
) -> Path:
    """Compact persistent top info bar shown after the intro card fades out."""
    style_key = archetype.lower() if archetype.lower() in ARCHETYPE_STYLES else "budget"
    accent_map = {
        "budget": (255, 212, 59, 255),
        "luxury": (245, 215, 145, 255),
        "villa": (52, 211, 153, 255),
        "commercial": (56, 189, 248, 255),
    }
    accent = accent_map.get(style_key, (255, 212, 59, 255))

    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        [0, 0, width - 1, height - 1],
        radius=height // 2,
        fill=(10, 14, 24, 195),
        outline=(accent[0], accent[1], accent[2], 120),
        width=1,
    )

    price = listing.get("price")
    curr = listing.get("currency") or "AZN"
    try:
        num_price = float(price) if price is not None else 0.0
        formatted_price = f"{int(num_price):,}".replace(",", " ") if num_price > 0 else "Münasib Qiymət"
    except (ValueError, TypeError):
        formatted_price = "Münasib Qiymət"

    raw_loc = listing.get("location") or listing.get("address") or "Bakı"
    loc_clean = re.sub(r'\bq\.(?=\s|$|[,\.!])', 'qəs.', raw_loc, flags=re.IGNORECASE).strip()
    parts = [f"{formatted_price} {curr}", loc_clean]
    if listing.get("rooms"):
        parts.append(f"{listing['rooms']} otaq")
    if listing.get("area"):
        try:
            parts.append(f"{int(float(listing['area']))} m²")
        except Exception:
            parts.append(f"{listing['area']} m²")
    text = "   ·   ".join(parts)

    font = get_best_font(size=24, bold=True)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = max(24, (width - tw) // 2)
    ty = (height - th) // 2 - bbox[1]
    draw.text((tx, ty), text, font=font, fill=(248, 250, 252, 250))

    if not output_path:
        output_path = Path("data/output/top_info_pill.png")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(output_path), "PNG")
    return output_path


def create_logo_watermark(
    output_path: Optional[Path] = None,
    logo_path: Optional[Path] = None,
    brand_text: str = "BAKU ESTATE",
    opacity: float = 0.78,
    width: int = 180,
    height: int = 40
) -> Path:
    """
    Generates a compact, semi-transparent brand logo watermark pill (icon + brand name)
    for anti-theft content protection across the full video duration.
    Compact pill dimensions: width=180, height=40 for mobile safe-zone placement at x=860, y=24.
    """
    if logo_path is None:
        logo_path = Path(__file__).resolve().parent.parent.parent / "assets" / "logo.png"

    w, h = width, height
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Subtle translucent dark smoked glass pill
    radius = h // 2
    draw.rounded_rectangle(
        [0, 0, w, h],
        radius=radius,
        fill=(10, 14, 22, 130),
        outline=(245, 215, 145, 95),
        width=1
    )

    icon_size = max(16, h - 12)
    icon_x = 6
    icon_y = (h - icon_size) // 2

    if logo_path.exists():
        try:
            with Image.open(logo_path) as raw_logo:
                logo = raw_logo.convert("RGBA")
                lw, lh = logo.size
                margin = int(min(lw, lh) * 0.14)
                logo = logo.crop((margin, margin, lw - margin, lh - margin))
                logo = logo.resize((icon_size, icon_size), Image.Resampling.LANCZOS)

                # Circular mask for emblem
                mask = Image.new("L", (icon_size, icon_size), 0)
                ImageDraw.Draw(mask).ellipse([0, 0, icon_size, icon_size], fill=255)
                img.paste(logo, (icon_x, icon_y), mask)
        except Exception as e:
            logger.warning(f"Could not embed logo image {logo_path}: {e}")

    font_brand_size = max(10, int(h * 0.32))  # 12-13pt for h=40
    font_sub_size = max(7, int(h * 0.20))     # 8-9pt for h=40

    font_brand = get_best_font(size=font_brand_size, bold=True)
    font_sub = get_best_font(size=font_sub_size, bold=False)

    text_x = icon_x + icon_size + 6
    text_y_brand = max(4, int(h * 0.15))
    text_y_sub = max(18, int(h * 0.54))

    draw.text((text_x, text_y_brand), brand_text, font=font_brand, fill=(255, 245, 215, 240))
    draw.text((text_x, text_y_sub), "VERIFIED LISTING", font=font_sub, fill=(210, 220, 235, 230))

    # Apply global subtle opacity so watermark protects video without distracting
    if 0.0 < opacity < 1.0:
        alpha = img.getchannel("A")
        alpha = alpha.point(lambda p: int(p * opacity))
        img.putalpha(alpha)

    if not output_path:
        output_path = Path("data/output/logo_watermark.png")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(output_path), "PNG")
    logger.info(f"Created brand logo watermark: {output_path} ({w}x{h})")
    return output_path


def create_cta_badge(
    listing: Optional[Dict[str, Any]] = None,
    output_path: Optional[Path] = None,
    width: int = 920,
    height: int = 140
) -> Path:
    """
    Renders a sleek, mobile safe-zone Call-to-Action badge for the final 3.5 seconds.
    Standardized kinetic CTA:
      Line 1: 'DƏQİQ ÜNVAN VƏ BAXIŞ ÜÇÜN'
      Line 2: 'ŞƏRHƏ 'EV' YAZIN VƏ YA DM GÖNDƏRİN'
      Line 3: 'WHATSAPP: <AGENCY_WHATSAPP_PHONE>'
    Positioned at y=1540 to keep the bottom clear of TikTok/Reels UI button collisions.
    Displays AGENCY_WHATSAPP_PHONE exclusively (protecting direct owner privacy).
    """
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle(
        [0, 0, width, height],
        radius=26,
        fill=(15, 23, 42, 220),
        outline=(16, 185, 129, 130),
        width=2
    )

    try:
        from config.settings import AGENCY_WHATSAPP_PHONE
    except ImportError:
        AGENCY_WHATSAPP_PHONE = os.getenv("AGENCY_WHATSAPP_PHONE", "994501234567")

    phone_raw = re.sub(r"\D", "", str(AGENCY_WHATSAPP_PHONE or "994501234567"))
    if len(phone_raw) == 12 and phone_raw.startswith("994"):
        formatted_phone = f"+994 {phone_raw[3:5]} {phone_raw[5:8]} {phone_raw[8:10]} {phone_raw[10:]}"
    elif len(phone_raw) == 10 and phone_raw.startswith("0"):
        formatted_phone = f"+994 {phone_raw[1:3]} {phone_raw[3:6]} {phone_raw[6:8]} {phone_raw[8:]}"
    elif phone_raw:
        formatted_phone = f"+{phone_raw}"
    else:
        formatted_phone = "+994 50 123 45 67"

    font_top = get_best_font(size=20, bold=True)
    font_sub = get_best_font(size=24, bold=True)
    font_phone = get_best_font(size=22, bold=True)

    line1 = "DƏQİQ ÜNVAN VƏ BAXIŞ ÜÇÜN"
    line2 = "ŞƏRHƏ 'EV' YAZIN VƏ YA DM GÖNDƏRİN"
    line3 = f"WHATSAPP: {formatted_phone}"

    # Center text lines
    bbox1 = draw.textbbox((0, 0), line1, font=font_top)
    w1 = bbox1[2] - bbox1[0]
    draw.text(((width - w1) // 2, 16), line1, font=font_top, fill=(245, 215, 145, 255))

    bbox2 = draw.textbbox((0, 0), line2, font=font_sub)
    w2 = bbox2[2] - bbox2[0]
    draw.text(((width - w2) // 2, 48), line2, font=font_sub, fill=(255, 255, 255, 255))

    bbox3 = draw.textbbox((0, 0), line3, font=font_phone)
    w3 = bbox3[2] - bbox3[0]
    draw.text(((width - w3) // 2, 88), line3, font=font_phone, fill=(52, 211, 153, 255))

    if not output_path:
        output_path = Path("data/output/cta_badge.png")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(output_path), "PNG")
    logger.info(f"Created standardized kinetic CTA badge: {output_path} ({width}x{height})")
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
    end_time: float = 3.2,
    target_y: int = 186
) -> Tuple[str, str]:
    """
    Returns (filter_str, escaped_path) for FFmpeg with optimized min 3.2s hero timing:
    - Centered at x=80 px, y=186 px (for w=920, h=176 inside 1080x1920)
    - Smooth slide-down in first 0.35s
    - Floats proudly for >= 3.0s to hook viewer attention
    - Dissolves / disappears cleanly at 3.2s into the apartment walkthrough
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
