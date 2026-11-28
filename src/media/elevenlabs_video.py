"""ElevenLabs Flows Image-to-Video Generator (Google Veo 3.1).

Animates real property photos into smooth cinematic walkthrough clips via
ElevenLabs Flows Video API (`POST /v1/flows/video`) with graceful fallback to
FFmpeg Ken Burns motion if the API key lacks Flows permissions or times out.
"""

from __future__ import annotations

import base64
import io
import logging
import os
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Dict, Optional

import requests
from PIL import Image

logger = logging.getLogger(__name__)

ELEVENLABS_FLOWS_VIDEO_URL = "https://api.elevenlabs.io/v1/flows/video"
DEFAULT_VIDEO_MODEL = "veo-3.1-fast-generate-001"
DEFAULT_SUBMIT_TIMEOUT = 20.0
DEFAULT_POLL_TIMEOUT = 150.0
DEFAULT_POLL_INTERVAL = 4.0
MAX_INPUT_DIMENSION = 1280


def _encode_photo_base64(image_path: Path, max_dimension: int = MAX_INPUT_DIMENSION) -> Optional[str]:
    """Loads a local property photo, resizes if needed, and returns base64 JPEG."""
    if not image_path.is_file():
        return None
    try:
        with Image.open(image_path) as img:
            w, h = img.size
            if max(w, h) > max_dimension:
                ratio = max_dimension / float(max(w, h))
                img = img.resize(
                    (max(1, int(w * ratio)), max(1, int(h * ratio))),
                    getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.BICUBIC),
                )
            if img.mode != "RGB":
                img = img.convert("RGB")
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=88)
            return base64.b64encode(buf.getvalue()).decode("utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to encode image %s for AI video: %s", image_path, exc)
        return None


def build_real_estate_motion_prompt(listing: Dict[str, Any], slide_index: int = 0) -> str:
    """Builds a photorealistic architectural camera-motion prompt grounded in the photo."""
    rooms = listing.get("rooms")
    location = str(listing.get("location") or "Baku").strip()
    scope = f"{rooms}-room apartment" if rooms else "luxury property"
    if slide_index == 0:
        return (
            f"Smooth cinematic steadycam glide forward into this exact {scope} in {location}. "
            "Natural daylight, subtle parallax depth, crisp architectural details. "
            "Strictly preserve the exact walls, furniture, windows, and layout from the input photo. "
            "No text, no watermarks, no people."
        )
    return (
        f"Gentle slow cinematic camera pan across this exact {scope} interior. "
        "Preserve all furniture, lighting, and geometry faithfully from the input photo. "
        "No text, no people."
    )


def animate_photo_to_video(
    image_path: str | Path,
    output_path: str | Path,
    prompt: str,
    api_key: Optional[str] = None,
    model_id: Optional[str] = None,
    submit_timeout: float = DEFAULT_SUBMIT_TIMEOUT,
    poll_timeout: float = DEFAULT_POLL_TIMEOUT,
    poll_interval: float = DEFAULT_POLL_INTERVAL,
) -> Optional[Path]:
    """Animates a single local photo via ElevenLabs Flows Video API (Veo 3.1).

    Returns the downloaded MP4 Path on success, or None on any permission/API/timeout error.
    """
    key = (api_key or os.getenv("ELEVENLABS_API_KEY", "")).strip()
    if not key:
        logger.info("ELEVENLABS_API_KEY unset; skipping AI video generation.")
        return None

    src = Path(image_path)
    out = Path(output_path)
    b64 = _encode_photo_base64(src)
    if not b64:
        return None

    target_model = (
        (model_id.strip() if isinstance(model_id, str) and model_id.strip() else None)
        or os.getenv("ELEVENLABS_VIDEO_MODEL")
        or DEFAULT_VIDEO_MODEL
    ).strip()

    headers = {
        "xi-api-key": key,
        "Content-Type": "application/json",
    }
    image_ref = {
        "type": "inline_base64",
        "content_base64": b64,
        "mime_type": "image/jpeg",
    }

    try:
        logger.info("Submitting ElevenLabs AI video (%s) for %s...", target_model, src.name)
        resp = None
        for frame_key in ("first_frame", "start_frame", "image"):
            payload: Dict[str, Any] = {
                "model_id": target_model,
                "prompt": prompt,
                frame_key: image_ref,
            }
            resp = requests.post(
                ELEVENLABS_FLOWS_VIDEO_URL,
                headers=headers,
                json=payload,
                timeout=submit_timeout,
            )
            if resp.status_code == 422 and frame_key != "image" and "extra_forbidden" in resp.text:
                logger.info("ElevenLabs Flows rejected '%s', retrying next frame key...", frame_key)
                continue
            break

        if resp is None or resp.status_code not in (200, 201, 202):
            logger.warning(
                "ElevenLabs Flows Video returned HTTP %s: %s",
                resp.status_code if resp is not None else "None",
                resp.text[:250] if resp is not None else "",
            )
            return None

        data = resp.json()
        gen_id = str(data.get("id") or "").strip()
        if not gen_id:
            logger.warning("ElevenLabs Flows Video response missing generation id: %s", data)
            return None

        status_url = f"{ELEVENLABS_FLOWS_VIDEO_URL}/{gen_id}"
        deadline = time.monotonic() + poll_timeout
        content_url: Optional[str] = None

        while time.monotonic() < deadline:
            poll_resp = requests.get(status_url, headers={"xi-api-key": key}, timeout=15.0)
            if poll_resp.status_code != 200:
                logger.warning(
                    "ElevenLabs Flows Video poll HTTP %s: %s",
                    poll_resp.status_code,
                    poll_resp.text[:200],
                )
                return None

            poll_data = poll_resp.json()
            status = str(poll_data.get("status") or "").lower()
            if status in ("completed", "succeeded", "done"):
                content_url = (
                    poll_data.get("content_url")
                    or poll_data.get("video_url")
                    or poll_data.get("url")
                )
                break
            if status in ("failed", "error", "cancelled"):
                logger.warning("ElevenLabs AI video job %s failed: %s", gen_id, poll_data)
                return None

            time.sleep(poll_interval)

        if not content_url:
            logger.warning("ElevenLabs AI video job %s timed out or lacked content_url.", gen_id)
            return None

        dl = requests.get(str(content_url), timeout=45.0)
        if dl.status_code != 200 or not dl.content:
            logger.warning("Failed to download AI video from %s (HTTP %s)", content_url, dl.status_code)
            return None

        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(dl.content)
        logger.info("Downloaded ElevenLabs AI video clip (%d bytes) -> %s", len(dl.content), out)
        return out

    except requests.exceptions.Timeout as exc:
        logger.warning("ElevenLabs AI video request timed out: %s", exc)
        return None
    except requests.exceptions.RequestException as exc:
        logger.warning("ElevenLabs AI video network error: %s", exc)
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("Unexpected error in ElevenLabs AI video: %s", exc)
        return None


def generate_ai_intro_clips(
    image_paths: Sequence[str | Path],
    output_dir: Path,
    listing: Dict[str, Any],
    max_clips: int = 1,
) -> Dict[int, Path]:
    """Generates AI-animated clips for the first `max_clips` key photos (default: hero #0)."""
    enabled_raw = os.getenv("ELEVENLABS_AI_VIDEO_ENABLED", "true").strip().lower()
    if enabled_raw in ("0", "false", "no", "off"):
        return {}

    try:
        cap = max(0, int(os.getenv("ELEVENLABS_AI_VIDEO_CLIPS", str(max_clips))))
    except ValueError:
        cap = max_clips

    if cap <= 0 or not image_paths:
        return {}

    clips: Dict[int, Path] = {}
    for idx in range(min(cap, len(image_paths))):
        prompt = build_real_estate_motion_prompt(listing, slide_index=idx)
        out_path = output_dir / f"ai_intro_{idx:02d}.mp4"
        res = animate_photo_to_video(
            image_path=image_paths[idx],
            output_path=out_path,
            prompt=prompt,
        )
        if res and res.is_file():
            clips[idx] = res
    return clips
