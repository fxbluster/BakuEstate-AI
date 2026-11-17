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

from config.settings import OUTPUT_DIR

logger = logging.getLogger("elevenlabs_tts")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


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
    stability: float = 0.45,
    similarity_boost: float = 0.80,
    style: float = 0.25,
    use_speaker_boost: bool = True
) -> float:
    """
    Synthesizes speech using ElevenLabs with-timestamps REST API endpoint.
    Produces high-fidelity studio MP3 and exact word-level synchronized SRT subtitles.
    Returns: duration in seconds.
    """
    key = api_key or os.getenv("ELEVENLABS_API_KEY", "")
    if not key:
        raise ValueError("ELEVENLABS_API_KEY is required for ElevenLabs TTS synthesis.")

    target_voice_id = voice_id or os.getenv("ELEVENLABS_VOICE_ID", "pNInz6obpgDQGcFmaJgB")  # Default Adam / Custom
    target_model = model_id or os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")

    output_audio_path.parent.mkdir(parents=True, exist_ok=True)
    output_srt_path.parent.mkdir(parents=True, exist_ok=True)

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{target_voice_id}/with-timestamps"
    headers = {
        "xi-api-key": key,
        "Content-Type": "application/json"
    }

    payload = {
        "text": text,
        "model_id": target_model,
        "voice_settings": {
            "stability": stability,
            "similarity_boost": similarity_boost,
            "style": style,
            "use_speaker_boost": use_speaker_boost
        }
    }

    logger.info(f"Synthesizing speech via ElevenLabs (Voice: {target_voice_id}, Model: {target_model})...")
    resp = requests.post(url, headers=headers, json=payload, timeout=60)

    if resp.status_code != 200:
        logger.error(f"ElevenLabs API Error ({resp.status_code}): {resp.text}")
        raise RuntimeError(f"ElevenLabs TTS failed: {resp.text}")

    data = resp.json()
    audio_base64 = data.get("audio_base64", "")
    alignment = data.get("alignment", {})

    if not audio_base64:
        raise RuntimeError("ElevenLabs returned empty audio data.")

    # Decode and write MP3
    audio_bytes = base64.b64decode(audio_base64)
    with open(output_audio_path, "wb") as f:
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
    with open(output_srt_path, "w", encoding="utf-8") as f:
        f.write(srt_content)

    logger.info(f"ElevenLabs synthesized {len(audio_bytes)} bytes ({duration:.2f}s, {len(words)} words) -> {output_audio_path}")
    logger.info(f"Generated frame-accurate SRT -> {output_srt_path}")

    return duration
