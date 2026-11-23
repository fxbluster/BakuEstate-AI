"""
kinetic_subtitles.py - Anti-AI Kinetic Typography Engine for BakuEstate-AI.
Generates modern 2-3 word rhythmic subtitle bursts with:
- Micro-bounce spring pop animation on entrance (\\fscx108\\fscy108)
- Dual-tone luxury color palette: Chalk White base + Champagne Gold & Mint pops
- Architectural DIN / Bahnschrift font with soft Gaussian drop shadow
- Zero cartoon black strokes (Outline=1.8, Shadow=2.2 with alpha transparency)
- Mobile safe-zone positioning (MarginV=540, baseline y=1380)
- Subtitles remain stationary in safe zone without vertical jumping during CTA (margin_v_cta = margin_v = 540)
"""

import os
import re
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

logger = logging.getLogger("kinetic_subtitles")

# Keywords for selective color highlighting (in ASS BGR format &HAABBGGRR)
# Vibrant Punchy Gold-Yellow: #FFD43B -> &H003BD4FF&
# Bright Mint Emerald:        #34D399 -> &H0099D334&
# Pure Crisp White:           #FFFFFF -> &H00FFFFFF&

COLOR_BASE = "&H00FFFFFF&"
COLOR_GOLD = "&H003BD4FF&"
COLOR_MINT = "&H0099D334&"

GOLD_STEMS = (
    "nərimanov", "nerimanov", "yasamal", "xətai", "xetai", "səbail", "sebail",
    "gənclik", "genclik", "sahil", "ağ şəhər", "ag seher", "elmlər", "elmler",
    "28 may", "nizami", "badamdar", "mərdəkan", "merdekan", "bilgəh", "bilgeh",
    "xalqlar", "dostlu", "neftçilər", "neftciler", "qara", "qarayev", "həzi",
    "əhmədli", "ehmedli", "inşaatçı", "insaatci", "memar", "əcəmi", "ecemi",
    "metro", "qiymət", "qiymet", "manat", "azn", "endirim", "təklif", "teklif",
    "münasib", "munasib", "fürsət", "furset", "möhtəşəm", "mohtesem", "lüks",
    "luks", "premium", "dizayn", "panoramik", "dəniz", "deniz", "mənzərə",
    "menzere", "super", "təmir", "temir", "əşyalı", "esyali", "otaq", "daş",
    "das", "eksperimental", "rahat", "geniş", "genis", "villa", "hovuz",
    "obyekt", "gəlir", "gelir", "whatsapp", "əlaqə", "elaqe"
)

MINT_STEMS = (
    "kupça", "kupca", "çıxarış", "cixaris", "sənəd", "sened",
    "ipoteka", "yararlı", "yararli", "komissiyasız", "komissiyasiz",
    "sahibindən", "sahibinden", "birbaşa", "birbasa", "təcili", "tecili"
)


def az_lower(text: str) -> str:
    """Azerbaijani locale-safe lowercasing (preserves ı/I and i/İ)."""
    return text.replace("I", "ı").replace("İ", "i").lower()


def az_upper(text: str) -> str:
    """Azerbaijani locale-safe uppercasing (preserves ı/I and i/İ)."""
    return text.replace("i", "İ").replace("ı", "I").upper()


def get_font_name() -> str:
    """Returns the best available clean sans-serif/grotesque font name."""
    candidates = [
        ("C:/Windows/Fonts/bahnschrift.ttf", "Bahnschrift"),
        ("C:/Windows/Fonts/segoeuib.ttf", "Segoe UI Semibold"),
        ("C:/Windows/Fonts/arialbd.ttf", "Arial"),
    ]
    for path, name in candidates:
        if os.path.exists(path):
            return name
    return "Arial"


def escape_ffmpeg_path(path: Path) -> str:
    """Escapes file path for FFmpeg filter syntax, especially for Windows drives."""
    posix_path = str(path.resolve()).replace("\\", "/")
    if ":" in posix_path:
        drive, rest = posix_path.split(":", 1)
        return f"{drive}\\:{rest}"
    return posix_path


def highlight_keywords_in_text(text: str) -> str:
    """
    Scans words in the chunk. If a word stem matches Gold or Mint categories,
    wraps it in color override tags. Numbers / prices are highlighted in Gold.
    """
    words = text.split()
    styled_words = []

    for w in words:
        clean = az_lower(re.sub(r'[^a-zA-Z0-9əöğçşıüƏÖĞÇŞIÜ]', '', w))
        has_digit = any(char.isdigit() for char in w)

        if any(clean.startswith(stem) for stem in MINT_STEMS):
            styled_words.append(f"{{\\c{COLOR_MINT}}}{w}{{\\c{COLOR_BASE}}}")
        elif has_digit or any(clean.startswith(stem) for stem in GOLD_STEMS):
            styled_words.append(f"{{\\c{COLOR_GOLD}}}{w}{{\\c{COLOR_BASE}}}")
        else:
            styled_words.append(w)

    return " ".join(styled_words)


def parse_timestamp_seconds(h: str, m: str, s: str, ms: str) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms[:3].ljust(3, "0")) / 1000.0


def format_ass_time(seconds: float) -> str:
    total_cs = int(round(seconds * 100))
    cs = total_cs % 100
    total_s = total_cs // 100
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def split_srt_block_into_chunks(text: str, start_s: float, end_s: float, max_words: int = 3) -> List[Dict[str, Any]]:
    """
    Splits a longer sentence into 2-3 word kinetic bursts,
    distributing the duration proportionally by word count.
    """
    words = text.strip().split()
    if not words:
        return []

    if len(words) <= max_words:
        return [{
            "start": start_s,
            "end": end_s,
            "text": text.strip()
        }]

    chunks = []
    chunk_words = []
    for w in words:
        chunk_words.append(w)
        if len(chunk_words) >= max_words:
            chunks.append(" ".join(chunk_words))
            chunk_words = []
    if chunk_words:
        if len(chunks) > 0 and len(chunk_words) == 1:
            chunks[-1] += " " + chunk_words[0]
        else:
            chunks.append(" ".join(chunk_words))

    total_duration = max(0.5, end_s - start_s)
    total_word_count = len(words)
    results = []
    current_time = start_s

    for i, c_text in enumerate(chunks):
        c_count = len(c_text.split())
        c_dur = total_duration * (c_count / total_word_count)
        c_end = current_time + c_dur
        if i == len(chunks) - 1:
            c_end = end_s
        results.append({
            "start": current_time,
            "end": c_end,
            "text": c_text
        })
        current_time = c_end

    return results


def convert_srt_to_kinetic_ass(
    srt_path: Path,
    ass_path: Path,
    margin_v: int = 540,
    margin_v_cta: int = 540,
    cta_start_time: Optional[float] = None,
    font_size: int = 52
) -> Path:
    """
    Converts an SRT file into modern kinetic ASS subtitles with:
    - 2 to 3-word rhythmic chunks
    - Micro-bounce spring pop animation: {\\t(0,90,\\fscx108\\fscy108)\\t(90,180,\\fscx100\\fscy100)}
    - Punchy vibrant gold-yellow & mint emerald keyword highlights
    - High-visibility 52pt typography with clean outline & drop shadow
    - Clean safe-zone placement (MarginV=540 default, baseline y=1380 in [1250, 1420] px)
    - Subtitles remain stationary at margin_v_cta = margin_v = 540 to eliminate vertical jumping during CTA
    """
    font_name = get_font_name()

    ass_header = f"""[Script Info]
Title: Baku Estate Kinetic Anti-AI
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: KineticSub,{font_name},{font_size},{COLOR_BASE},&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,1.2,0,1,2.8,3.4,2,60,60,{margin_v},1
Style: KineticSubCTA,{font_name},{font_size},{COLOR_BASE},&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,1.2,0,1,2.8,3.4,2,60,60,{margin_v_cta},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    dialogues = []
    if srt_path.exists():
        content = srt_path.read_text(encoding="utf-8")
        blocks = re.split(r'\n\s*\n', content.strip())

        for block in blocks:
            lines = [l.strip() for l in block.splitlines() if l.strip()]
            if len(lines) >= 3 and "-->" in lines[1]:
                m = re.match(r'(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)', lines[1])
                if m:
                    sh, sm, ss, sms, eh, em, es, ems = m.groups()
                    start_s = parse_timestamp_seconds(sh, sm, ss, sms)
                    end_s = parse_timestamp_seconds(eh, em, es, ems)
                    full_text = " ".join(lines[2:])

                    chunks = split_srt_block_into_chunks(full_text, start_s, end_s, max_words=3)
                    for chunk in chunks:
                        ass_start = format_ass_time(chunk["start"])
                        ass_end = format_ass_time(chunk["end"])
                        chunk_text = az_upper(chunk["text"])

                        # Pick style: if during CTA phase, use elevated KineticSubCTA
                        style_name = "KineticSub"
                        if cta_start_time is not None and chunk["start"] >= (cta_start_time - 0.2):
                            style_name = "KineticSubCTA"

                        # Add micro-bounce spring effect + keyword styling
                        styled_body = highlight_keywords_in_text(chunk_text)
                        kinetic_line = f"{{\\t(0,90,\\fscx108\\fscy108)\\t(90,180,\\fscx100\\fscy100)}}{styled_body}"
                        dialogues.append(f"Dialogue: 0,{ass_start},{ass_end},{style_name},,0,0,0,,{kinetic_line}")

    ass_path.parent.mkdir(parents=True, exist_ok=True)
    with open(ass_path, "w", encoding="utf-8") as f:
        f.write(ass_header + "\n".join(dialogues) + "\n")

    logger.info(f"Generated {len(dialogues)} kinetic subtitle lines in {ass_path}")
    return ass_path


def build_kinetic_ass_from_words(
    words_with_timestamps: List[Dict[str, Any]],
    ass_path: Path,
    margin_v: int = 540,
    margin_v_cta: int = 540,
    cta_start_time: Optional[float] = None,
    font_size: int = 52
) -> Path:
    """
    Directly builds 2-3 word kinetic bursts from millisecond-accurate word timestamps
    (e.g., ElevenLabs /with-timestamps or Whisper word alignments).
    Each word dict format: {"word": str, "start": float, "end": float}
    """
    font_name = get_font_name()
    ass_header = f"""[Script Info]
Title: Baku Estate Kinetic Anti-AI (Word-Aligned)
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: KineticSub,{font_name},{font_size},{COLOR_BASE},&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,1.2,0,1,2.8,3.4,2,60,60,{margin_v},1
Style: KineticSubCTA,{font_name},{font_size},{COLOR_BASE},&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,1.2,0,1,2.8,3.4,2,60,60,{margin_v_cta},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    dialogues = []
    chunk = []

    for idx, w_info in enumerate(words_with_timestamps):
        chunk.append(w_info)
        # Flush every 2 or 3 words or at end
        if len(chunk) == 3 or idx == len(words_with_timestamps) - 1:
            chunk_start = chunk[0]["start"]
            chunk_end = chunk[-1]["end"]
            chunk_text = az_upper(" ".join([w["word"] for w in chunk]))

            ass_start = format_ass_time(chunk_start)
            ass_end = format_ass_time(chunk_end)

            style_name = "KineticSub"
            if cta_start_time is not None and chunk_start >= (cta_start_time - 0.2):
                style_name = "KineticSubCTA"

            styled_body = highlight_keywords_in_text(chunk_text)
            kinetic_line = f"{{\\t(0,90,\\fscx108\\fscy108)\\t(90,180,\\fscx100\\fscy100)}}{styled_body}"
            dialogues.append(f"Dialogue: 0,{ass_start},{ass_end},{style_name},,0,0,0,,{kinetic_line}")
            chunk = []

    ass_path.parent.mkdir(parents=True, exist_ok=True)
    with open(ass_path, "w", encoding="utf-8") as f:
        f.write(ass_header + "\n".join(dialogues) + "\n")

    logger.info(f"Built {len(dialogues)} word-aligned kinetic lines in {ass_path}")
    return ass_path


def get_bottom_scrim_overlay_filter(scrim_path: Path) -> Tuple[str, str]:
    """Returns FFmpeg overlay expression and escaped path for bottom gradient scrim."""
    escaped = escape_ffmpeg_path(scrim_path)
    return "overlay=0:0:format=auto", escaped
