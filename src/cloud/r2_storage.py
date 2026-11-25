"""
Private Cloudflare R2 S3-compatible Media Storage Client for BakuEstate-AI v2.

Security & Architecture Contract:
- The R2 bucket is strictly PRIVATE (zero public r2.dev access).
- NEVER persist 7-day S3 SigV4 pre-signed URLs in `render_versions.video_cdn_url`.
  Store canonical `storage_object_path` (`videos/{agency_id}/{listing_id}/v{n}.mp4`)
  and `storage_provider='r2'` in Postgres; serve videos through the verified Cloudflare
  Worker custom domain (`https://media.bakuestate.az/v/<object_path>`) with short-lived
  HMAC-SHA256 URL signatures for browser playback and domain-verified URLs for TikTok
  `PULL_FROM_URL`.

Recommended Cloudflare R2 Bucket CORS Policy (for direct browser OFF_MARKET PUT uploads):
```json
[
  {
    "AllowedOrigins": [
      "https://bakuestate.az",
      "https://app.bakuestate.az",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type", "Content-Length", "x-amz-*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```
Recommended Lifecycle Rule:
- Prefix `staging/`: Expire incomplete/orphaned OFF_MARKET photo uploads after 7 days.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Union

from config.settings import (
    R2_ACCESS_KEY_ID,
    R2_ACCOUNT_ID,
    R2_BUCKET,
    R2_MEDIA_BASE_URL,
    R2_SECRET_ACCESS_KEY,
)

logger = logging.getLogger("r2_storage")

DEFAULT_R2_MEDIA_BASE_URL = "https://media.bakuestate.az"

R2_CORS_POLICY_DOC = {
    "AllowedOrigins": [
        "https://bakuestate.az",
        "https://app.bakuestate.az",
        "http://localhost:3000",
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type", "Content-Length", "x-amz-*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600,
}


@dataclass(frozen=True)
class R2UploadResult:
    """Immutable metadata returned by `R2StorageClient.upload_video`."""

    object_path: str
    cdn_url: str
    size_bytes: int


def _normalize_object_key(object_path: str) -> str:
    clean = str(object_path or "").strip().lstrip("/")
    if not clean:
        raise ValueError("R2 object_path must not be empty")
    if ".." in Path(clean).parts:
        raise ValueError(f"Invalid R2 object_path traversal: {object_path}")
    return clean


class R2StorageClient:
    """
    S3-compatible Cloudflare R2 client for private MP4 uploads, deletion,
    and short-lived HMAC-signed Cloudflare Worker CDN media URLs.
    """

    def __init__(
        self,
        *,
        account_id: Optional[str] = None,
        access_key_id: Optional[str] = None,
        secret_access_key: Optional[str] = None,
        bucket: Optional[str] = None,
        media_base_url: Optional[str] = None,
        signing_secret: Optional[str] = None,
        endpoint_url: Optional[str] = None,
        s3_client: Optional[Any] = None,
    ):
        self.account_id = (
            account_id
            if account_id is not None
            else (os.getenv("R2_ACCOUNT_ID") or R2_ACCOUNT_ID or "")
        ).strip()
        self.access_key_id = (
            access_key_id
            if access_key_id is not None
            else (os.getenv("R2_ACCESS_KEY_ID") or R2_ACCESS_KEY_ID or "")
        ).strip()
        self.secret_access_key = (
            secret_access_key
            if secret_access_key is not None
            else (os.getenv("R2_SECRET_ACCESS_KEY") or R2_SECRET_ACCESS_KEY or "")
        ).strip()
        self.bucket = (
            bucket
            if bucket is not None
            else (os.getenv("R2_BUCKET") or R2_BUCKET or "baku-estate-media")
        ).strip()
        raw_base = (
            media_base_url
            if media_base_url is not None
            else (
                os.getenv("R2_MEDIA_BASE_URL")
                or os.getenv("NEXT_PUBLIC_R2_MEDIA_BASE_URL")
                or R2_MEDIA_BASE_URL
                or DEFAULT_R2_MEDIA_BASE_URL
            )
        )
        self.media_base_url = (raw_base or DEFAULT_R2_MEDIA_BASE_URL).strip().rstrip("/")
        self.signing_secret = (
            signing_secret
            if signing_secret is not None
            else (
                os.getenv("R2_MEDIA_SIGNING_SECRET")
                or os.getenv("R2_SIGNING_SECRET")
                or self.secret_access_key
            )
        ).strip()
        self.endpoint_url = (
            endpoint_url.strip().rstrip("/")
            if endpoint_url
            else (
                f"https://{self.account_id}.r2.cloudflarestorage.com"
                if self.account_id
                else ""
            )
        )
        self._s3_client = s3_client

    def is_configured(self) -> bool:
        """Returns True when either an injected S3 client or full R2 credentials exist."""
        if self._s3_client is not None:
            return bool(self.bucket)
        return bool(
            self.endpoint_url
            and self.access_key_id
            and self.secret_access_key
            and self.bucket
        )

    def _get_s3_client(self) -> Any:
        if self._s3_client is not None:
            return self._s3_client
        if not self.is_configured():
            raise RuntimeError(
                "R2StorageClient is not configured (missing R2_ACCOUNT_ID / "
                "R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET)."
            )
        try:
            import boto3
            from botocore.config import Config
        except ImportError as exc:
            raise RuntimeError(
                "boto3>=1.35.0 is required for Cloudflare R2 uploads. "
                "Install it via `pip install -r requirements.txt`."
            ) from exc

        self._s3_client = boto3.client(
            "s3",
            endpoint_url=self.endpoint_url,
            aws_access_key_id=self.access_key_id,
            aws_secret_access_key=self.secret_access_key,
            region_name="auto",
            config=Config(signature_version="s3v4"),
        )
        return self._s3_client

    def build_cdn_url(self, object_path: str) -> str:
        """
        Builds the canonical Cloudflare Worker custom-domain URL (`https://media.bakuestate.az/v/...`).
        Never returns a raw `r2.cloudflarestorage.com` or 7-day S3 SigV4 pre-signed URL.
        """
        clean_key = _normalize_object_key(object_path)
        encoded_key = urllib.parse.quote(clean_key, safe="/")
        base = self.media_base_url
        if base.endswith("/v"):
            return f"{base}/{encoded_key}"
        return f"{base}/v/{encoded_key}"

    def upload_video(
        self,
        local_path: Union[str, Path],
        object_key: str,
        *,
        content_type: str = "video/mp4",
    ) -> R2UploadResult:
        """
        Uploads a local MP4 file to the private R2 bucket and returns
        `R2UploadResult(object_path, cdn_url, size_bytes)`.
        """
        path = Path(local_path)
        if not path.is_file():
            raise FileNotFoundError(f"Video file not found for R2 upload: {local_path}")

        clean_key = _normalize_object_key(object_key)
        video_bytes = path.read_bytes()
        size_bytes = len(video_bytes)

        client = self._get_s3_client()
        logger.info(
            "Uploading %s (%d bytes) to private R2 bucket '%s'...",
            clean_key,
            size_bytes,
            self.bucket,
        )
        client.put_object(
            Bucket=self.bucket,
            Key=clean_key,
            Body=video_bytes,
            ContentType=content_type,
            CacheControl="private, max-age=3600",
        )
        cdn_url = self.build_cdn_url(clean_key)
        logger.info("R2 upload complete: %s -> %s", clean_key, cdn_url)
        return R2UploadResult(
            object_path=clean_key,
            cdn_url=cdn_url,
            size_bytes=size_bytes,
        )

    def delete_object(self, object_path: str) -> bool:
        """Deletes an object from the private R2 bucket. Returns True on success."""
        if not object_path or not self.is_configured():
            return False
        try:
            clean_key = _normalize_object_key(object_path)
            client = self._get_s3_client()
            client.delete_object(Bucket=self.bucket, Key=clean_key)
            logger.info("Deleted R2 object '%s' from bucket '%s'.", clean_key, self.bucket)
            return True
        except Exception as exc:
            logger.error("Failed to delete R2 object '%s': %s", object_path, exc)
            return False

    def _compute_signature(self, clean_key: str, exp: int) -> str:
        if not self.signing_secret:
            raise ValueError(
                "Cannot mint signed media URL without R2_MEDIA_SIGNING_SECRET / R2_SECRET_ACCESS_KEY."
            )
        msg = f"{clean_key}:{exp}".encode("utf-8")
        return hmac.new(
            self.signing_secret.encode("utf-8"),
            msg,
            hashlib.sha256,
        ).hexdigest()

    def mint_signed_media_url(
        self,
        object_path: str,
        ttl_seconds: int = 3600,
        *,
        now_ts: Optional[int] = None,
    ) -> str:
        """
        Mints a short-lived HMAC-SHA256 signed Cloudflare Worker media URL
        for authenticated Web CRM playback (`https://media.bakuestate.az/v/<path>?exp=...&sig=...`).
        """
        clean_key = _normalize_object_key(object_path)
        ttl = max(1, min(int(ttl_seconds), 86400))
        base_ts = int(now_ts) if now_ts is not None else int(time.time())
        exp = base_ts + ttl
        sig = self._compute_signature(clean_key, exp)
        cdn_url = self.build_cdn_url(clean_key)
        return f"{cdn_url}?exp={exp}&sig={sig}"

    def verify_signed_media_url(
        self,
        object_path: str,
        signed_url: str,
        *,
        now_ts: Optional[int] = None,
    ) -> bool:
        """Verifies a short-lived HMAC-signed Worker media URL."""
        try:
            clean_key = _normalize_object_key(object_path)
            parsed = urllib.parse.urlparse(signed_url)
            params = urllib.parse.parse_qs(parsed.query)
            exp = int((params.get("exp") or [""])[0])
            sig = str((params.get("sig") or [""])[0]).strip()
            if not sig:
                return False
            current_ts = int(now_ts) if now_ts is not None else int(time.time())
            if exp < current_ts:
                return False
            expected = self._compute_signature(clean_key, exp)
            return hmac.compare_digest(expected, sig)
        except Exception:
            return False
