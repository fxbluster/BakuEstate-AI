"""BakuEstate Multimodal Vision Analyzer.

Analyzes locally downloaded listing photos using OpenAI GPT-4o Vision API.
Extracts verified interior and exterior visual attributes to enrich video
generation scripts, avoiding hallucinations and bypassing Cloudflare bot blocks.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import requests
from PIL import Image

logger = logging.getLogger(__name__)

OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"
DEFAULT_VISION_MODEL = "gpt-4o"
DEFAULT_VISION_TIMEOUT = 15.0
MAX_IMAGE_DIMENSION = 1080

VALID_RENOVATION_QUALITIES = {
    "euro",
    "modern_luxury",
    "scandinavian",
    "classic",
    "needs_repair",
    "standard",
}


@dataclass
class PropertyVisualProfile:
    """Encapsulates verified visual characteristics of a property."""

    renovation_quality: str = "standard"  # euro, modern_luxury, scandinavian, classic, needs_repair
    floor_and_ceiling: str = ""           # e.g. natural parquet, stretch ceiling with spotlights
    kitchen_appliances: str = ""          # e.g. built-in Bosch, stone countertop
    view_and_lighting: str = ""           # e.g. panoramic sea/city view, floor-to-ceiling windows
    hook_sentence_az: str = ""            # 1-sentence punchy Azerbaijani marketing hook for video script
    standout_features: list[str] = field(default_factory=list)
    is_fallback: bool = False

    def to_dict(self) -> dict[str, Any]:
        """Serializes visual profile to a dictionary."""
        return {
            "renovation_quality": self.renovation_quality,
            "floor_and_ceiling": self.floor_and_ceiling,
            "kitchen_appliances": self.kitchen_appliances,
            "view_and_lighting": self.view_and_lighting,
            "hook_sentence_az": self.hook_sentence_az,
            "standout_features": list(self.standout_features),
            "is_fallback": self.is_fallback,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> PropertyVisualProfile:
        """Deserializes a dictionary into a PropertyVisualProfile instance."""
        if not isinstance(d, dict) or not d:
            return cls(is_fallback=True)

        renovation_raw = str(d.get("renovation_quality") or "standard").strip().lower()
        if renovation_raw not in VALID_RENOVATION_QUALITIES:
            renovation_raw = "standard"

        standout_raw = d.get("standout_features")
        if isinstance(standout_raw, list):
            standout_features = [str(item).strip() for item in standout_raw if item]
        else:
            standout_features = []

        return cls(
            renovation_quality=renovation_raw,
            floor_and_ceiling=str(d.get("floor_and_ceiling") or "").strip(),
            kitchen_appliances=str(d.get("kitchen_appliances") or "").strip(),
            view_and_lighting=str(d.get("view_and_lighting") or "").strip(),
            hook_sentence_az=str(d.get("hook_sentence_az") or "").strip(),
            standout_features=standout_features,
            is_fallback=bool(d.get("is_fallback", False)),
        )


def select_key_photos(image_paths: Sequence[Path | str]) -> list[Path]:
    """Selects up to 5 representative photos deterministically using index sampling.

    Formula: [0, 1, len//3, len//2, -1], deduplicating indices while preserving order.
    """
    if not image_paths:
        return []

    paths = [Path(p) for p in image_paths]
    n = len(paths)
    if n <= 5:
        return paths

    raw_indices = [0, 1, n // 3, n // 2, -1]
    # Normalize negative index and preserve deterministic order with deduplication
    normalized_indices = [idx if idx >= 0 else n + idx for idx in raw_indices]
    seen = set()
    selected_indices = []
    for idx in normalized_indices:
        if 0 <= idx < n and idx not in seen:
            seen.add(idx)
            selected_indices.append(idx)

    return [paths[i] for i in selected_indices]


def encode_image_to_base64_jpeg(image_path: str | Path, max_dimension: int = MAX_IMAGE_DIMENSION) -> str | None:
    """Reads a local image file, resizes to max_dimension if larger, and encodes to base64."""
    path = Path(image_path)
    if not path.is_file():
        logger.warning("Image path does not exist or is not a file: %s", path)
        return None

    try:
        with Image.open(path) as img:
            width, height = img.size
            if max(width, height) > max_dimension:
                ratio = max_dimension / float(max(width, height))
                new_size = (max(1, int(width * ratio)), max(1, int(height * ratio)))
                resample_filter = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.BICUBIC)
                resized = img.resize(new_size, resample=resample_filter)
                if resized.mode in ("RGBA", "LA", "P"):
                    resized = resized.convert("RGB")
                buf = io.BytesIO()
                resized.save(buf, format="JPEG", quality=85)
                return base64.b64encode(buf.getvalue()).decode("utf-8")
            else:
                if getattr(img, "format", "").upper() == "JPEG" and img.mode == "RGB":
                    return base64.b64encode(path.read_bytes()).decode("utf-8")
                else:
                    rgb_img = img.convert("RGB") if img.mode in ("RGBA", "LA", "P") else img
                    buf = io.BytesIO()
                    rgb_img.save(buf, format="JPEG", quality=85)
                    return base64.b64encode(buf.getvalue()).decode("utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to encode image %s to base64: %s", path, exc)
        return None


def _clean_and_parse_json(content: str) -> dict[str, Any]:
    """Safely extracts and parses JSON payload from LLM response text."""
    if not content:
        raise ValueError("Empty content string")

    stripped = content.strip()
    # Strip markdown code fence if present
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", stripped)
    if match:
        stripped = match.group(1).strip()

    return json.loads(stripped)


def analyze_listing_photos(
    image_paths: Sequence[Path | str],
    api_key: str | None = None,
    timeout: float = DEFAULT_VISION_TIMEOUT,
) -> PropertyVisualProfile:
    """Analyzes listing photos via OpenAI GPT-4o Vision API.

    Circuit Breaker: On timeout, 4xx, 5xx, or network exception, catches gracefully,
    logs a warning, and returns PropertyVisualProfile(is_fallback=True).
    """
    key = (api_key or os.getenv("OPENAI_API_KEY", "")).strip()
    if not key:
        logger.warning("OPENAI_API_KEY is not configured; returning fallback PropertyVisualProfile.")
        return PropertyVisualProfile(is_fallback=True)

    selected_paths = select_key_photos(image_paths)
    if not selected_paths:
        logger.warning("No image paths provided for vision analysis; returning fallback PropertyVisualProfile.")
        return PropertyVisualProfile(is_fallback=True)

    # Encode selected local photos
    encoded_images: list[str] = []
    for p in selected_paths:
        b64 = encode_image_to_base64_jpeg(p)
        if b64:
            encoded_images.append(b64)

    if not encoded_images:
        logger.warning("None of the selected images could be encoded; returning fallback PropertyVisualProfile.")
        return PropertyVisualProfile(is_fallback=True)

    # Build prompt and payload
    user_content: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": (
                "You are an expert real estate appraiser and architectural visual analyst in Baku, Azerbaijan.\n"
                "Inspect the attached photos of the property and return ONLY a valid JSON object with the following schema:\n"
                "{\n"
                '  "renovation_quality": "euro" | "modern_luxury" | "scandinavian" | "classic" | "needs_repair" | "standard",\n'
                '  "floor_and_ceiling": "description of flooring and ceiling fixtures (e.g. natural oak parquet, stretch ceiling with spotlights)",\n'
                '  "kitchen_appliances": "description of kitchen appliances and countertops (e.g. built-in Bosch, stone countertop)",\n'
                '  "view_and_lighting": "description of view and natural lighting (e.g. panoramic Caspian sea view, floor-to-ceiling windows)",\n'
                '  "hook_sentence_az": "1 punchy marketing hook in Azerbaijani highlighting the property\'s top visual strength",\n'
                '  "standout_features": ["3 to 5 notable verified visual highlights"]\n'
                "}\n"
                "Do not fabricate or guess features not visible in the photos. Return strictly valid JSON."
            ),
        }
    ]

    for b64 in encoded_images:
        user_content.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:image/jpeg;base64,{b64}",
                "detail": "low",
            },
        })

    payload = {
        "model": DEFAULT_VISION_MODEL,
        "messages": [
            {
                "role": "system",
                "content": "You are an expert Baku real estate visual analyst. Always respond in valid JSON format.",
            },
            {
                "role": "user",
                "content": user_content,
            },
        ],
        "max_tokens": 500,
        "response_format": {"type": "json_object"},
    }

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }

    try:
        response = requests.post(
            OPENAI_CHAT_COMPLETIONS_URL,
            headers=headers,
            json=payload,
            timeout=timeout,
        )

        if response.status_code != 200:
            logger.warning(
                "OpenAI Vision API returned HTTP %s: %s",
                response.status_code,
                response.text[:250],
            )
            return PropertyVisualProfile(is_fallback=True)

        data = response.json()
        choices = data.get("choices", [])
        if not choices:
            logger.warning("OpenAI Vision API response contained no choices: %s", data)
            return PropertyVisualProfile(is_fallback=True)

        message_content = choices[0].get("message", {}).get("content", "")
        parsed_dict = _clean_and_parse_json(message_content)

        profile = PropertyVisualProfile.from_dict(parsed_dict)
        profile.is_fallback = False
        return profile

    except requests.exceptions.Timeout as exc:
        logger.warning("OpenAI Vision API request timed out after %.1fs: %s", timeout, exc)
        return PropertyVisualProfile(is_fallback=True)
    except requests.exceptions.RequestException as exc:
        logger.warning("OpenAI Vision API network error: %s", exc)
        return PropertyVisualProfile(is_fallback=True)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Unexpected error during vision analysis: %s", exc)
        return PropertyVisualProfile(is_fallback=True)
