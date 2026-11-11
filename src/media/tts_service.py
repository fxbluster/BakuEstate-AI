"""
Edge-TTS service for Azerbaijani speech synthesis and synchronized word-level subtitle generation.
Uses Microsoft Edge-TTS voice 'az-AZ-BabekNeural' at rate '+10%'.
Generates high-quality MP3 audio and synchronized SRT subtitles.
"""

import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import os
import asyncio
import logging
import re
from pathlib import Path
from datetime import timedelta
from typing import Dict, Any, Tuple, Optional, List
import edge_tts

from config.settings import EDGE_TTS_VOICE, EDGE_TTS_RATE, OUTPUT_DIR

logger = logging.getLogger("tts_service")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def format_srt_time(td: timedelta) -> str:
    """Formats a timedelta into standard SRT timestamp format: HH:MM:SS,mmm"""
    total_seconds = int(td.total_seconds())
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    milliseconds = int(td.microseconds / 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def azerbaijani_ordinal_suffix(n: int) -> str:
    """Returns correct vowel-harmonized ordinal suffix in Azerbaijani (-ci, -cü, -cı, -cu)."""
    try:
        val = abs(int(n))
    except (ValueError, TypeError):
        return "-ci"
    last_two = val % 100
    last_one = val % 10
    if last_two in (10, 30):
        return "-cu"
    elif last_two in (20, 50, 70, 80):
        return "-ci"
    elif last_two in (40, 60, 90):
        return "-cı"
    elif last_one in (1, 2, 5, 7, 8):
        return "-ci"
    elif last_one in (3, 4):
        return "-cü"
    elif last_one == 6:
        return "-cı"
    elif last_one in (9, 0):
        return "-cu"
    return "-ci"


def normalize_azerbaijani_phonetics(text: str) -> str:
    """Normalizes abbreviations, numbers, and units for natural speech synthesis."""
    if not text:
        return ""
    replacements = [
        (r'\b(\d+)\s*000\s*AZN\b', r'\1 min manat'),
        (r'\b(\d+)\s*AZN\b', r'\1 manat'),
        (r'\bAZN\b', 'manat'),
        (r'\bkv\.?\s*m\b', 'kvadrat metr'),
        (r'\bm²\b', 'kvadrat metr'),
        (r'\bq\.(?=\s|$|[,\.!])', 'qəsəbəsində'),
        (r'\bm\.(?=\s|$|[,\.!])', 'metrosu yaxınlığında'),
        (r'\bküç\.(?=\s|$|[,\.!])', 'küçəsində'),
        (r'\bpr\.(?=\s|$|[,\.!])', 'prospektində'),
        (r'\b(\d+)/(\d+)\b', r'\2 mərtəbəli binanın \1-ci mərtəbəsində'),
    ]
    for pattern, repl in replacements:
        text = re.sub(pattern, repl, text, flags=re.IGNORECASE)
    return text


def generate_azerbaijani_script(listing: Dict[str, Any]) -> str:
    """
    Generates an energetic, high-converting Azerbaijani narration script for a real estate listing.
    Features dynamic hooks, emotional emphasis, price clarity, and clear call-to-action.
    """
    parts = []

    # Dynamic Hook
    loc = listing.get("location") or listing.get("address") or "Bakı"
    parts.append(f"Dayanın! {loc} ərazisində qaçırılmayacaq şok təklif!")

    # Location & parameters
    rooms = listing.get("rooms")
    area = listing.get("area")
    floor = listing.get("floor")
    floors = listing.get("floors")

    if rooms and area:
        parts.append(f"Tam {rooms} otaqlı, {int(area)} kvadrat metr sahəsi olan möhtəşəm mənzil satılır!")
    elif rooms:
        parts.append(f"{rooms} otaqlı, tam təmirli və çox rahat mənzil təklif olunur!")
    else:
        parts.append("Tam təmirli, dərhal köçüb yaşamağa hazır gözəl bir ev!")

    if floor and floors:
        suffix = azerbaijani_ordinal_suffix(floor)
        parts.append(f"Mənzil {floors} mərtəbəli binanın {floor}{suffix} mərtəbəsində yerləşir.")

    # Kupça badge statement
    if listing.get("has_bill_of_sale"):
        parts.append("Ən əsası nədir bilirsiniz? Dövlət çıxarışı, yəni kupçası var! İpotekaya tam hazırdır!")

    # Price statement
    price = listing.get("price")
    if price and price > 0:
        price_in_thousands = int(price / 1000) if price >= 1000 else int(price)
        parts.append(f"Qiyməti cəmi {price_in_thousands} min manat!")

    # Direct owner statement
    if listing.get("is_owner"):
        parts.append("Birbaşa sahibindən satılır, heç bir vasitəçi komissiyası yoxdur!")
    else:
        parts.append("Bu qiymətə belə ev bazarda nadir hallarda çıxır!")

    # Call to action
    parts.append("Tələsin! Ətraflı məlumat üçün dərhal WhatsApp-a yazın və ya zəng edin!")

    return " ".join(parts)


def convert_cues_to_word_level_srt(cues: List[Any], words_per_chunk: int = 3) -> str:
    """
    Converts sentence-level cues into dynamic 2-3 word karaoke chunks
    for modern vertical video subtitle burning.
    Ensures strictly positive duration for all chunks with no zero-duration errors.
    """
    srt_blocks = []
    global_idx = 1

    for cue in cues:
        raw_text = cue.content.strip()
        # Split on regular whitespace, preserving non-breaking spaces within tokens (e.g. price)
        words = raw_text.split(" ")
        words = [w.strip() for w in words if w.strip()]
        if not words:
            continue

        start_time = cue.start
        end_time = cue.end
        total_duration = max(0.2, (end_time - start_time).total_seconds())

        # Chunk words into groups of words_per_chunk
        chunks = []
        for i in range(0, len(words), words_per_chunk):
            chunk_words = words[i:i + words_per_chunk]
            chunks.append(chunk_words)

        if not chunks:
            continue

        total_chars = sum(len(w) for w in words) or 1
        current_start = start_time

        for i, chunk in enumerate(chunks):
            chunk_text = " ".join(chunk).replace("\u00A0", " ")
            if i == len(chunks) - 1:
                current_end = end_time
            else:
                chunk_chars = sum(len(w) for w in chunk)
                chunk_ratio = chunk_chars / total_chars
                current_end = current_start + timedelta(seconds=total_duration * chunk_ratio)

            # Guard: ensure current_end is strictly greater than current_start
            if current_end <= current_start:
                current_end = current_start + timedelta(milliseconds=150)

            srt_blocks.append(
                f"{global_idx}\n"
                f"{format_srt_time(current_start)} --> {format_srt_time(current_end)}\n"
                f"{chunk_text}\n"
            )
            global_idx += 1
            current_start = current_end

    return "\n".join(srt_blocks)


async def synthesize_speech_async(
    text: str,
    output_audio_path: Path,
    output_srt_path: Path,
    voice: str = EDGE_TTS_VOICE,
    rate: str = EDGE_TTS_RATE,
    use_word_level_subtitles: bool = True
) -> float:
    """
    Synthesizes speech asynchronously using Edge-TTS and saves both audio and SRT.
    Returns estimated audio duration in seconds.
    """
    output_audio_path.parent.mkdir(parents=True, exist_ok=True)
    output_srt_path.parent.mkdir(parents=True, exist_ok=True)

    logger.info(f"Synthesizing speech with voice '{voice}' at rate '{rate}'...")
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    submaker = edge_tts.SubMaker()
    audio_data = bytearray()

    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_data.extend(chunk["data"])
        elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
            if submaker.type is None or submaker.type == chunk["type"]:
                submaker.feed(chunk)

    with open(output_audio_path, "wb") as f:
        f.write(audio_data)

    # Format subtitles
    if use_word_level_subtitles and submaker.cues:
        srt_content = convert_cues_to_word_level_srt(submaker.cues, words_per_chunk=3)
    else:
        srt_content = submaker.get_srt()

    with open(output_srt_path, "w", encoding="utf-8") as f:
        f.write(srt_content)

    # Calculate duration from SubMaker cues or MP3 size
    duration = 0.0
    if submaker.cues:
        duration = submaker.cues[-1].end.total_seconds()
    if duration <= 0:
        # Fallback estimation: average 16000 bytes/sec for edge-tts 64kbps mp3
        duration = max(3.0, len(audio_data) / 16000.0)

    logger.info(f"Synthesized {len(audio_data)} bytes ({duration:.2f}s audio) -> {output_audio_path}")
    logger.info(f"Generated SRT subtitles -> {output_srt_path}")
    return duration


def generate_tts_for_listing(
    listing: Dict[str, Any],
    output_dir: Optional[Path] = None,
    voice: str = EDGE_TTS_VOICE,
    rate: str = EDGE_TTS_RATE,
    custom_script: Optional[str] = None
) -> Tuple[str, str, str, float]:
    """
    Synchronous wrapper to generate full Azerbaijani narration script,
    Edge-TTS voiceover, and SRT subtitles for a listing.
    Allows passing a custom AI script (e.g. from Google Gemini Pro).
    Returns: (script_text, audio_path, srt_path, duration_seconds)
    """
    target_dir = output_dir or OUTPUT_DIR
    target_dir.mkdir(parents=True, exist_ok=True)

    bina_id = listing.get("bina_id", "sample")
    audio_path = target_dir / f"voice_{bina_id}.mp3"
    srt_path = target_dir / f"subs_{bina_id}.srt"

    raw_script = custom_script or generate_azerbaijani_script(listing)
    script_text = normalize_azerbaijani_phonetics(raw_script)

    # Check for OpenAI Studio Voiceover
    openai_key = os.getenv("OPENAI_API_KEY", "")
    tts_engine = os.getenv("TTS_ENGINE", "openai" if openai_key else "edge").lower()

    if tts_engine == "openai" and openai_key:
        try:
            from src.media.openai_tts import synthesize_openai_speech
            logger.info("Using OpenAI Studio TTS for natural professional voiceover...")
            duration = synthesize_openai_speech(
                text=script_text,
                output_audio_path=audio_path,
                output_srt_path=srt_path,
                api_key=openai_key
            )
            return script_text, str(audio_path.resolve()), str(srt_path.resolve()), duration
        except Exception as e:
            logger.warning(f"OpenAI TTS failed: {e}. Falling back to Edge-TTS Babek.")

    duration = asyncio.run(synthesize_speech_async(
        text=script_text,
        output_audio_path=audio_path,
        output_srt_path=srt_path,
        voice=voice,
        rate=rate
    ))

    return script_text, str(audio_path.resolve()), str(srt_path.resolve()), duration
