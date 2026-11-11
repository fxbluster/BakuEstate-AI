"""
OpenAI Studio TTS integration for Baku Estate AI.
Generates ultra-natural, human-grade voiceovers (voices: onyx, alloy, echo, nova, shimmer)
and produces synchronized word-level subtitles.
"""

import os
import sys
import re
import json
import logging
import subprocess
from pathlib import Path
from datetime import timedelta
from typing import Tuple, Optional, List, Dict, Any
import requests

from config.settings import (
    OUTPUT_DIR,
    OPENAI_API_KEY,
    OPENAI_TTS_MODEL,
    OPENAI_TTS_VOICE,
    OPENAI_TTS_SPEED
)

logger = logging.getLogger("openai_tts")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def format_srt_time(td: timedelta) -> str:
    """Formats a timedelta into standard SRT timestamp format: HH:MM:SS,mmm"""
    total_seconds = int(td.total_seconds())
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    milliseconds = int(td.microseconds / 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def probe_audio_duration_ffmpeg(audio_path: Path) -> float:
    """Measures audio duration using ffmpeg binary."""
    try:
        from src.media.ffmpeg_compositor import get_ffmpeg_executable
        ffmpeg_exe = get_ffmpeg_executable()
        cmd = [ffmpeg_exe, "-i", str(audio_path)]
        res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", res.stderr)
        if m:
            hours = int(m.group(1))
            minutes = int(m.group(2))
            seconds = float(m.group(3))
            return hours * 3600 + minutes * 60 + seconds
    except Exception as e:
        logger.warning(f"Failed to probe audio duration via ffmpeg: {e}")

    # Fallback estimation for 64-128kbps mp3
    try:
        size = audio_path.stat().st_size
        return max(5.0, size / 16000.0)
    except Exception:
        return 25.0


def generate_synchronized_srt(text: str, total_duration: float, words_per_chunk: int = 3) -> str:
    """
    Generates balanced word-level SRT subtitles proportionally mapped
    across the total audio duration.
    """
    words = [w.strip() for w in text.split() if w.strip()]
    if not words:
        return ""

    chunks = []
    for i in range(0, len(words), words_per_chunk):
        chunks.append(words[i:i + words_per_chunk])

    total_chars = sum(len(w) for w in words) or 1
    srt_blocks = []
    current_start = timedelta(seconds=0.0)

    for idx, chunk in enumerate(chunks, 1):
        chunk_text = " ".join(chunk)
        chunk_chars = sum(len(w) for w in chunk)
        chunk_ratio = chunk_chars / total_chars
        chunk_duration = total_duration * chunk_ratio

        current_end = current_start + timedelta(seconds=chunk_duration)
        if current_end <= current_start:
            current_end = current_start + timedelta(milliseconds=200)

        # Ensure last chunk reaches total duration
        if idx == len(chunks):
            current_end = timedelta(seconds=total_duration)

        srt_blocks.append(
            f"{idx}\n"
            f"{format_srt_time(current_start)} --> {format_srt_time(current_end)}\n"
            f"{chunk_text}\n"
        )
        current_start = current_end

    return "\n".join(srt_blocks)


def synthesize_openai_speech(
    text: str,
    output_audio_path: Path,
    output_srt_path: Path,
    api_key: Optional[str] = None,
    voice: Optional[str] = None,
    model: Optional[str] = None,
    speed: Optional[float] = None
) -> float:
    """
    Synthesizes speech using OpenAI TTS endpoint and outputs both MP3 and synced SRT subtitles.
    Returns: duration in seconds.
    """
    key = api_key or os.getenv("OPENAI_API_KEY", "") or OPENAI_API_KEY
    if not key:
        raise ValueError("OPENAI_API_KEY is required for OpenAI TTS synthesis.")

    target_voice = voice or os.getenv("OPENAI_TTS_VOICE", "onyx")
    target_model = model or os.getenv("OPENAI_TTS_MODEL", "tts-1")
    target_speed = speed or float(os.getenv("OPENAI_TTS_SPEED", "1.05"))

    output_audio_path.parent.mkdir(parents=True, exist_ok=True)
    output_srt_path.parent.mkdir(parents=True, exist_ok=True)

    url = "https://api.openai.com/v1/audio/speech"
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": target_model,
        "input": text,
        "voice": target_voice,
        "speed": target_speed,
        "response_format": "mp3"
    }

    logger.info(f"Synthesizing studio voiceover with OpenAI TTS (voice: '{target_voice}', model: '{target_model}')...")
    resp = requests.post(url, headers=headers, json=payload, timeout=60)

    if resp.status_code != 200:
        logger.error(f"OpenAI TTS API Error ({resp.status_code}): {resp.text}")
        raise RuntimeError(f"OpenAI TTS request failed: {resp.text}")

    with open(output_audio_path, "wb") as f:
        f.write(resp.content)

    duration = probe_audio_duration_ffmpeg(output_audio_path)
    logger.info(f"OpenAI TTS synthesized {len(resp.content)} bytes ({duration:.2f}s) -> {output_audio_path}")

    # Generate synchronized subtitle track
    srt_content = generate_synchronized_srt(text, duration, words_per_chunk=3)
    with open(output_srt_path, "w", encoding="utf-8") as f:
        f.write(srt_content)
    logger.info(f"Generated synchronized word-level SRT -> {output_srt_path}")

    return duration
