"""
ElevenLabs Studio TTS integration for Baku Estate AI.
Generates ultra-realistic, human-grade voiceovers with emotional nuance,
natural breathing, and frame-accurate word-level timestamps.
"""

import os
import sys
import re
import json
import base64
import logging
from pathlib import Path
from datetime import timedelta
from typing import Tuple, Optional, List, Dict, Any
import requests

from config.settings import (
    OUTPUT_DIR,
    ELEVENLABS_API_KEY,
    ELEVENLABS_VOICE_ID,
    ELEVENLABS_VOICE_ARIF,
    ELEVENLABS_VOICE_BANU,
    ELEVENLABS_MODEL_ID,
)

logger = logging.getLogger("elevenlabs_tts")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


class ElevenLabsSynthesisError(Exception):
    """Raised when ElevenLabs speech synthesis fails due to quota, auth, timeout, or server error."""
    pass


ELEVENLABS_VOICE_ALIASES: Dict[str, str] = {
    "eleven_male": ELEVENLABS_VOICE_ARIF,
    "arif": ELEVENLABS_VOICE_ARIF,
    "male": ELEVENLABS_VOICE_ARIF,
    "eleven_female": ELEVENLABS_VOICE_BANU,
    "female": ELEVENLABS_VOICE_BANU,
    "banu": ELEVENLABS_VOICE_BANU,
}


def _synthesize_edge_fallback(
    text: str,
    output_audio_path: Path,
    output_srt_path: Path,
    voice: str,
) -> float:
    """Helper to synthesize audio and SRT using Edge-TTS during fallback."""
    import asyncio
    from src.media.tts_service import synthesize_speech_async

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            return executor.submit(
                asyncio.run,
                synthesize_speech_async(
                    text=text,
                    output_audio_path=output_audio_path,
                    output_srt_path=output_srt_path,
                    voice=voice,
                )
            ).result()
    else:
        return asyncio.run(
            synthesize_speech_async(
                text=text,
                output_audio_path=output_audio_path,
                output_srt_path=output_srt_path,
                voice=voice,
            )
        )


def resolve_elevenlabs_voice_id(voice_id: Optional[str] = None) -> str:
    """Resolves explicit voice ID or friendly alias without mutating os.environ."""
    if voice_id and str(voice_id).strip():
        raw = str(voice_id).strip()
        return ELEVENLABS_VOICE_ALIASES.get(raw.lower(), raw)
    return os.getenv("ELEVENLABS_VOICE_ID") or ELEVENLABS_VOICE_ID or "ZQJv3hwvRAIC7fvWZ1Qr"


def seconds_to_srt_time(seconds: float) -> str:
    """Formats seconds into standard SRT timestamp format: HH:MM:SS,mmm"""
    total_seconds = max(0.0, float(seconds))
    hours = int(total_seconds // 3600)
    minutes = int((total_seconds % 3600) // 60)
    secs = int(total_seconds % 60)
    millis = int(round((total_seconds - int(total_seconds)) * 1000))
    if millis >= 1000:
        millis = 999
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def parse_alignment_to_words(alignment: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Parses ElevenLabs character-level alignment arrays into structured words
    with exact start and end timestamps.
    """
    chars = alignment.get("characters", [])
    starts = alignment.get("character_start_times_seconds", [])
    ends = alignment.get("character_end_times_seconds", [])

    if not chars or not starts or not ends:
        return []

    words = []
    current_word = ""
    word_start = None
    word_end = None

    for char, start, end in zip(chars, starts, ends):
        if word_start is None:
            word_start = start

        if char.isspace() or char in ("\n", "\t", "\r"):
            if current_word.strip():
                words.append({
                    "word": current_word.strip(),
                    "start": word_start,
                    "end": word_end if word_end is not None else end
                })
            current_word = ""
            word_start = None
        else:
            current_word += char
            word_end = end

    if current_word.strip():
        words.append({
            "word": current_word.strip(),
            "start": word_start if word_start is not None else (ends[-1] if ends else 0.0),
            "end": word_end if word_end is not None else (ends[-1] if ends else 0.0)
        })

    return words


def build_word_level_srt(words: List[Dict[str, Any]], words_per_chunk: int = 3, max_duration: float = 2.5) -> str:
    """
    Groups words into short dynamic 2-3 word karaoke chunks
    for high-retention vertical reels.
    """
    if not words:
        return ""

    srt_blocks = []
    chunk = []
    chunk_start = None
    global_idx = 1

    for w in words:
        if not chunk:
            chunk_start = w["start"]

        chunk.append(w["word"])
        chunk_end = w["end"]

        if len(chunk) >= words_per_chunk or (chunk_end - chunk_start) >= max_duration:
            text = " ".join(chunk).strip()
            # Guard strictly increasing time
            if chunk_end <= chunk_start:
                chunk_end = chunk_start + 0.2

            srt_blocks.append(
                f"{global_idx}\n"
                f"{seconds_to_srt_time(chunk_start)} --> {seconds_to_srt_time(chunk_end)}\n"
                f"{text}\n"
            )
            global_idx += 1
            chunk = []
            chunk_start = None

    if chunk:
        text = " ".join(chunk).strip()
        last_end = words[-1]["end"]
        if chunk_start is None:
            chunk_start = words[-1]["start"]
        if last_end <= chunk_start:
            last_end = chunk_start + 0.2

        srt_blocks.append(
            f"{global_idx}\n"
            f"{seconds_to_srt_time(chunk_start)} --> {seconds_to_srt_time(last_end)}\n"
            f"{text}\n"
        )

    return "\n".join(srt_blocks)


def synthesize_elevenlabs_speech(
    text: str,
    output_audio_path: Path,
    output_srt_path: Path,
    api_key: Optional[str] = None,
    voice_id: Optional[str] = None,
    model_id: Optional[str] = None,
    stability: float = 0.52,
    similarity_boost: float = 0.82,
    style: float = 0.28,
    use_speaker_boost: bool = True,
    version_num: Optional[int] = None,
    speed: Optional[float] = None,
) -> float:
    """
    Synthesizes speech using ElevenLabs with-timestamps REST API endpoint.
    Produces high-fidelity studio MP3 (44.1kHz 128kbps) and exact word-level synchronized SRT subtitles.
    Accepts explicit voice_id/model_id/version_num/speed without mutating global os.environ.
    Raises ElevenLabsSynthesisError on 401, 402, 429, 5xx, or timeout.
    Returns: duration in seconds.
    """
    key = api_key or os.getenv("ELEVENLABS_API_KEY", "") or ELEVENLABS_API_KEY
    if not key:
        raise ValueError("ELEVENLABS_API_KEY is required for ElevenLabs TTS synthesis.")

    target_voice_id = resolve_elevenlabs_voice_id(voice_id)
    raw_model = (
        (model_id.strip() if isinstance(model_id, str) and model_id.strip() else None)
        or os.getenv("ELEVENLABS_MODEL_ID")
        or ELEVENLABS_MODEL_ID
        or "eleven_multilingual_v2"
    )
    if not raw_model or raw_model.strip().lower() in ("eleven_v4", "v4", "eleven_turbo_v4", "none"):
        target_model = "eleven_multilingual_v2"
    else:
        target_model = raw_model.strip()

    audio_out = Path(output_audio_path)
    srt_out = Path(output_srt_path)
    if version_num is not None:
        ver = max(1, int(version_num))
        if not re.search(rf"_v{ver}$", audio_out.stem):
            audio_out = audio_out.with_name(f"{audio_out.stem}_v{ver}{audio_out.suffix}")
        if not re.search(rf"_v{ver}$", srt_out.stem):
            srt_out = srt_out.with_name(f"{srt_out.stem}_v{ver}{srt_out.suffix}")

    audio_out.parent.mkdir(parents=True, exist_ok=True)
    srt_out.parent.mkdir(parents=True, exist_ok=True)

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{target_voice_id}/with-timestamps?output_format=mp3_44100_128"
    headers = {
        "xi-api-key": key,
        "Content-Type": "application/json"
    }

    voice_settings: Dict[str, Any] = {
        "stability": stability,
        "similarity_boost": similarity_boost,
        "use_speaker_boost": use_speaker_boost
    }
    if style and style > 0:
        voice_settings["style"] = style
    if speed is not None:
        voice_settings["speed"] = float(speed)

    payload = {
        "text": text,
        "model_id": target_model,
        "voice_settings": voice_settings
    }

    logger.info(f"Synthesizing speech via ElevenLabs (Voice: {target_voice_id}, Model: {target_model}, Speed: {speed})...")
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=15.0)
    except requests.exceptions.Timeout as e:
        logger.error(f"ElevenLabs API request timed out after 15.0s: {e}")
        raise ElevenLabsSynthesisError(f"ElevenLabs request timed out after 15.0s: {e}") from e
    except requests.exceptions.RequestException as e:
        logger.error(f"ElevenLabs API network error: {e}")
        raise ElevenLabsSynthesisError(f"ElevenLabs network error: {e}") from e

    if resp.status_code in (401, 402, 429) or (500 <= resp.status_code < 600) or (resp.status_code == 400 and "quota" in resp.text.lower()):
        err_msg = (
            f"ElevenLabs API error {resp.status_code}: {resp.text[:180] if resp.text else ''}"
        )
        logger.warning(f"{err_msg} - raising ElevenLabsSynthesisError...")
        raise ElevenLabsSynthesisError(err_msg)

    if resp.status_code != 200:
        logger.error(f"ElevenLabs API Error ({resp.status_code}): {resp.text}")
        raise ElevenLabsSynthesisError(f"ElevenLabs TTS failed ({resp.status_code}): {resp.text}")

    data = resp.json()
    audio_base64 = data.get("audio_base64", "")
    alignment = data.get("alignment", {})

    if not audio_base64:
        raise RuntimeError("ElevenLabs returned empty audio data.")

    # Decode and write MP3
    audio_bytes = base64.b64decode(audio_base64)
    with open(audio_out, "wb") as f:
        f.write(audio_bytes)

    # Process timestamps & SRT
    words = parse_alignment_to_words(alignment)
    duration = 0.0
    if words:
        duration = words[-1]["end"]
    if duration <= 0:
        # Fallback estimation
        duration = max(3.0, len(audio_bytes) / 16000.0)

    srt_content = build_word_level_srt(words, words_per_chunk=3)
    with open(srt_out, "w", encoding="utf-8") as f:
        f.write(srt_content)

    logger.info(f"ElevenLabs synthesized {len(audio_bytes)} bytes ({duration:.2f}s, {len(words)} words) -> {audio_out}")
    logger.info(f"Generated frame-accurate SRT -> {srt_out}")

    return duration
