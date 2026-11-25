"""
Official Meta Graph API (Instagram Reels) & TikTok Content Posting API v2 Clients
for BakuEstate-AI v2 Phase 3.

Security & Architecture Contract:
- Access and refresh tokens are stored encrypted in Supabase Vault and accessed
  exclusively via `service_role` SQL RPCs (`read_social_secret`, `store_social_secret`).
  Never query `vault` schema directly over PostgREST.
- Meta Instagram Reels uses the 2-step Container API:
  `POST /{ig_user_id}/media` -> poll `status_code == 'FINISHED'` -> `POST /{ig_user_id}/media_publish`.
- TikTok Content Posting API v2 uses `PULL_FROM_URL` exclusively over the verified
  Cloudflare Worker custom domain (`https://media.bakuestate.az/v/...`).
- Automatic proactive token refresh handles 24h TikTok and 60d Meta expirations.
"""

from __future__ import annotations

import logging
import os
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional

import requests

from config.settings import R2_MEDIA_BASE_URL
from src.cloud.r2_storage import DEFAULT_R2_MEDIA_BASE_URL, R2StorageClient

logger = logging.getLogger("src.social.official_clients")

DEFAULT_META_GRAPH_VERSION = os.getenv("META_GRAPH_API_VERSION", "v21.0").strip() or "v21.0"
DEFAULT_TIKTOK_API_BASE = "https://open.tiktokapis.com/v2"
DEFAULT_VERIFIED_MEDIA_HOST = "media.bakuestate.az"


class OfficialSocialError(Exception):
    """Base error for official Meta / TikTok social API integrations."""


class SocialTokenRefreshError(OfficialSocialError):
    """Raised when an OAuth access/refresh token cannot be refreshed."""


class MediaPublishError(OfficialSocialError):
    """Raised when media publishing or container polling fails."""


def _utc_now(now: Optional[datetime] = None) -> datetime:
    if now is None:
        return datetime.now(timezone.utc)
    if now.tzinfo is None:
        return now.replace(tzinfo=timezone.utc)
    return now.astimezone(timezone.utc)


def _parse_iso_dt(value: Any) -> Optional[datetime]:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return _utc_now(value)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
            return _utc_now(dt)
        except ValueError:
            return None
    return None


def _is_real_repo_http(repo: Any) -> bool:
    return (
        repo is not None
        and isinstance(getattr(repo, "supabase_url", None), str)
        and bool(repo.supabase_url)
        and isinstance(getattr(repo, "supabase_key", None), str)
        and bool(repo.supabase_key)
        and getattr(repo, "session", None) is not None
    )


def _repo_headers(repo: Any, prefer: Optional[str] = None) -> Dict[str, str]:
    if hasattr(repo, "_headers") and callable(repo._headers):
        try:
            hdrs = repo._headers(prefer=prefer)
            if isinstance(hdrs, dict):
                return hdrs
        except TypeError:
            pass
    headers = {
        "apikey": repo.supabase_key,
        "Authorization": f"Bearer {repo.supabase_key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def _repo_rpc_url(repo: Any, fn_name: str) -> str:
    if hasattr(repo, "_rpc_url") and callable(repo._rpc_url):
        val = repo._rpc_url(fn_name)
        if isinstance(val, str):
            return val
    return f"{repo.supabase_url.rstrip('/')}/rest/v1/rpc/{fn_name}"


def _repo_rest_url(repo: Any, table: str) -> str:
    if hasattr(repo, "_rest_url") and callable(repo._rest_url):
        val = repo._rest_url(table)
        if isinstance(val, str):
            return val
    return f"{repo.supabase_url.rstrip('/')}/rest/v1/{table}"


def read_social_secret(repo: Any, secret_id: str) -> str:
    """
    Decrypts a Vault social token exclusively via `public.read_social_secret(p_secret_id)`.
    """
    clean_id = str(secret_id or "").strip()
    if not clean_id:
        raise OfficialSocialError("vault_secret_id is required to read social secret")

    if not _is_real_repo_http(repo):
        raise OfficialSocialError("SupabaseRepo with service_role configuration is required for Vault RPCs")

    resp = repo.session.post(
        _repo_rpc_url(repo, "read_social_secret"),
        headers=_repo_headers(repo),
        json={"p_secret_id": clean_id},
        timeout=getattr(repo, "timeout", 20),
    )
    if resp.status_code != 200:
        raise OfficialSocialError(
            f"read_social_secret RPC failed ({resp.status_code}): {str(getattr(resp, 'text', ''))[:240]}"
        )
    data = resp.json()
    if isinstance(data, list):
        data = data[0] if data else None
    if isinstance(data, dict):
        data = data.get("read_social_secret") or data.get("decrypted_secret") or data.get("secret")
    if not data or not isinstance(data, str):
        raise OfficialSocialError(f"read_social_secret returned empty secret for {clean_id}")
    return data


def store_social_secret(repo: Any, name: str, secret: str) -> str:
    """
    Encrypts and stores a social token in Vault via `public.store_social_secret(p_name, p_secret)`.
    Returns the Vault secret UUID string.
    """
    clean_name = str(name or "").strip()
    clean_secret = str(secret or "")
    if not clean_name or not clean_secret:
        raise OfficialSocialError("p_name and p_secret are required for store_social_secret")

    if not _is_real_repo_http(repo):
        raise OfficialSocialError("SupabaseRepo with service_role configuration is required for Vault RPCs")

    resp = repo.session.post(
        _repo_rpc_url(repo, "store_social_secret"),
        headers=_repo_headers(repo),
        json={"p_name": clean_name, "p_secret": clean_secret},
        timeout=getattr(repo, "timeout", 20),
    )
    if resp.status_code != 200:
        raise OfficialSocialError(
            f"store_social_secret RPC failed ({resp.status_code}): {str(getattr(resp, 'text', ''))[:240]}"
        )
    data = resp.json()
    if isinstance(data, list):
        data = data[0] if data else None
    if isinstance(data, dict):
        data = data.get("store_social_secret") or data.get("id")
    if not data or not isinstance(data, str):
        raise OfficialSocialError(f"store_social_secret returned empty UUID for {clean_name}")
    return data.strip()


def fetch_active_social_account(
    repo: Any,
    agency_id: str,
    platform: str,
    account_handle: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Fetches an active `public.social_accounts` row for the given agency and platform."""
    if not _is_real_repo_http(repo) or not agency_id:
        return None
    clean_platform = str(platform or "").strip().upper()
    params: Dict[str, str] = {
        "agency_id": f"eq.{str(agency_id).strip()}",
        "platform": f"eq.{clean_platform}",
        "is_active": "eq.true",
        "select": "*",
        "order": "updated_at.desc",
        "limit": "10",
    }
    resp = repo.session.get(
        _repo_rest_url(repo, "social_accounts"),
        headers=_repo_headers(repo),
        params=params,
        timeout=getattr(repo, "timeout", 20),
    )
    if resp.status_code != 200:
        logger.warning("fetch_active_social_account failed (%s): %s", resp.status_code, str(resp.text)[:200])
        return None
    rows = resp.json() or []
    active_rows = [
        r for r in rows
        if r.get("is_active", True) and str(r.get("status") or "ACTIVE").upper() == "ACTIVE"
    ]
    if not active_rows:
        return None
    if account_handle:
        clean_handle = str(account_handle).strip().lower()
        for row in active_rows:
            if str(row.get("account_handle") or "").strip().lower() == clean_handle:
                return row
    return active_rows[0]


def _extract_verified_media_host(r2_storage: Optional[R2StorageClient] = None) -> str:
    base = (
        (r2_storage.media_base_url if r2_storage is not None else "")
        or os.getenv("R2_MEDIA_BASE_URL")
        or os.getenv("NEXT_PUBLIC_R2_MEDIA_BASE_URL")
        or R2_MEDIA_BASE_URL
        or DEFAULT_R2_MEDIA_BASE_URL
    ).strip()
    parsed = urllib.parse.urlparse(base)
    return (parsed.hostname or DEFAULT_VERIFIED_MEDIA_HOST).lower()


def validate_tiktok_pull_url(video_url: str, r2_storage: Optional[R2StorageClient] = None) -> str:
    """
    Ensures TikTok `PULL_FROM_URL` uses HTTPS on the domain-verified Cloudflare Worker
    custom domain (`media.bakuestate.az`), never raw `r2.cloudflarestorage.com`.
    """
    clean_url = str(video_url or "").strip()
    if not clean_url:
        raise MediaPublishError("video_url is required for TikTok PULL_FROM_URL")
    parsed = urllib.parse.urlparse(clean_url)
    host = (parsed.hostname or "").lower()
    expected_host = _extract_verified_media_host(r2_storage)
    if parsed.scheme != "https" or not host or "r2.cloudflarestorage.com" in host:
        raise MediaPublishError(
            f"TikTok PULL_FROM_URL requires HTTPS verified custom domain ({expected_host}), got: {clean_url}"
        )
    if host != expected_host and host != DEFAULT_VERIFIED_MEDIA_HOST:
        raise MediaPublishError(
            f"TikTok PULL_FROM_URL host '{host}' does not match verified domain '{expected_host}'"
        )
    return clean_url


class OfficialSocialPublisher:
    """
    Official Meta Graph API (Instagram Reels) & TikTok Content Posting API v2 publisher
    and telemetry/comment sync client backed by Supabase Vault RPCs.
    """

    def __init__(
        self,
        repo: Any,
        *,
        http_session: Optional[Any] = None,
        r2_storage: Optional[R2StorageClient] = None,
        graph_api_version: str = DEFAULT_META_GRAPH_VERSION,
        poll_interval_seconds: float = 2.0,
        max_poll_attempts: int = 15,
        sleep_fn: Callable[[float], None] = time.sleep,
        timeout: int = 30,
    ):
        self.repo = repo
        self.http = http_session or requests.Session()
        self.r2_storage = r2_storage or R2StorageClient()
        self.graph_api_version = (graph_api_version or DEFAULT_META_GRAPH_VERSION).strip()
        self.poll_interval_seconds = max(0.0, float(poll_interval_seconds))
        self.max_poll_attempts = max(1, int(max_poll_attempts))
        self._sleep = sleep_fn
        self.timeout = int(timeout)

    def resolve_media_url(
        self,
        *,
        video_url: Optional[str] = None,
        render_version: Optional[Dict[str, Any]] = None,
        signed_ttl_seconds: int = 3600,
    ) -> str:
        """
        Resolves the HTTPS media URL from a render_version (`storage_object_path` on R2 ->
        `https://media.bakuestate.az/v/...`) or an explicit `video_url`.
        """
        rv = render_version or {}
        obj_path = str(rv.get("storage_object_path") or "").strip()
        provider = str(rv.get("storage_provider") or "r2").strip().lower()
        if obj_path and provider == "r2":
            if self.r2_storage.signing_secret:
                return self.r2_storage.mint_signed_media_url(obj_path, ttl_seconds=signed_ttl_seconds)
            return self.r2_storage.build_cdn_url(obj_path)

        explicit = str(video_url or rv.get("video_cdn_url") or "").strip()
        if explicit.startswith("https://") or explicit.startswith("http://"):
            return explicit
        raise MediaPublishError("Unable to resolve valid media URL from render_version or params")

    def publish_instagram_reel(
        self,
        account: Dict[str, Any],
        video_url: str,
        caption: str,
        *,
        share_to_feed: bool = True,
    ) -> Dict[str, Any]:
        """
        Executes Meta Graph API 2-step Reels Container publishing:
        1. POST /{ig_user_id}/media (create container)
        2. Poll GET /{container_id}?fields=status_code,status until FINISHED
        3. POST /{ig_user_id}/media_publish
        """
        ig_user_id = str(account.get("external_account_id") or "").strip()
        secret_id = str(account.get("vault_secret_id") or "").strip()
        if not ig_user_id:
            raise MediaPublishError("Instagram account missing external_account_id (ig_user_id)")
        access_token = read_social_secret(self.repo, secret_id)

        base = f"https://graph.facebook.com/{self.graph_api_version}"
        create_resp = self.http.post(
            f"{base}/{ig_user_id}/media",
            data={
                "media_type": "REELS",
                "video_url": video_url,
                "caption": str(caption or "")[:2200],
                "share_to_feed": "true" if share_to_feed else "false",
                "access_token": access_token,
            },
            timeout=self.timeout,
        )
        if create_resp.status_code not in (200, 201):
            raise MediaPublishError(
                f"Meta Reels container creation failed ({create_resp.status_code}): {str(getattr(create_resp, 'text', ''))[:240]}"
            )
        container_id = str((create_resp.json() or {}).get("id") or "").strip()
        if not container_id:
            raise MediaPublishError("Meta Reels container creation returned empty container id")

        # Step 2: Poll container processing status
        final_status = None
        for attempt in range(self.max_poll_attempts):
            poll_resp = self.http.get(
                f"{base}/{container_id}",
                params={
                    "fields": "status_code,status",
                    "access_token": access_token,
                },
                timeout=self.timeout,
            )
            if poll_resp.status_code != 200:
                raise MediaPublishError(
                    f"Meta container poll failed ({poll_resp.status_code}): {str(getattr(poll_resp, 'text', ''))[:240]}"
                )
            poll_data = poll_resp.json() or {}
            status_code = str(poll_data.get("status_code") or "").strip().upper()
            if status_code == "FINISHED":
                final_status = status_code
                break
            if status_code in ("ERROR", "EXPIRED"):
                raise MediaPublishError(
                    f"Meta Reels container {container_id} failed with status={status_code}: {poll_data.get('status')}"
                )
            if attempt + 1 < self.max_poll_attempts and self.poll_interval_seconds > 0:
                self._sleep(self.poll_interval_seconds)

        if final_status != "FINISHED":
            raise MediaPublishError(
                f"Meta Reels container {container_id} did not reach FINISHED within {self.max_poll_attempts} polls"
            )

        # Step 3: Publish container
        pub_resp = self.http.post(
            f"{base}/{ig_user_id}/media_publish",
            data={
                "creation_id": container_id,
                "access_token": access_token,
            },
            timeout=self.timeout,
        )
        if pub_resp.status_code not in (200, 201):
            raise MediaPublishError(
                f"Meta Reels media_publish failed ({pub_resp.status_code}): {str(getattr(pub_resp, 'text', ''))[:240]}"
            )
        external_post_id = str((pub_resp.json() or {}).get("id") or "").strip()
        if not external_post_id:
            raise MediaPublishError("Meta media_publish returned empty media id")

        post_url = None
        try:
            meta_resp = self.http.get(
                f"{base}/{external_post_id}",
                params={"fields": "permalink,shortcode", "access_token": access_token},
                timeout=self.timeout,
            )
            if meta_resp.status_code == 200:
                meta_json = meta_resp.json() or {}
                post_url = meta_json.get("permalink")
                if not post_url and meta_json.get("shortcode"):
                    post_url = f"https://www.instagram.com/reel/{meta_json['shortcode']}/"
        except Exception as exc:
            logger.debug("Optional permalink lookup failed for %s: %s", external_post_id, exc)

        return {
            "platform": "INSTAGRAM",
            "channel": "INSTAGRAM_REELS",
            "container_id": container_id,
            "external_post_id": external_post_id,
            "post_url": post_url,
            "status": "PUBLISHED",
        }

    def publish_tiktok_video(
        self,
        account: Dict[str, Any],
        video_url: str,
        title: str,
        *,
        privacy_level: str = "PUBLIC_TO_EVERYONE",
    ) -> Dict[str, Any]:
        """
        Publishes a video to TikTok Content Posting API v2 via `PULL_FROM_URL`
        using the verified Cloudflare Worker domain (`media.bakuestate.az`).
        """
        verified_url = validate_tiktok_pull_url(video_url, self.r2_storage)
        secret_id = str(account.get("vault_secret_id") or "").strip()
        access_token = read_social_secret(self.repo, secret_id)

        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json; charset=UTF-8",
        }
        init_payload = {
            "post_info": {
                "title": str(title or "")[:2200],
                "privacy_level": privacy_level,
                "disable_duet": False,
                "disable_comment": False,
                "disable_stitch": False,
            },
            "source_info": {
                "source": "PULL_FROM_URL",
                "video_url": verified_url,
            },
        }
        init_resp = self.http.post(
            f"{DEFAULT_TIKTOK_API_BASE}/post/publish/video/init/",
            headers=headers,
            json=init_payload,
            timeout=self.timeout,
        )
        if init_resp.status_code not in (200, 201):
            raise MediaPublishError(
                f"TikTok video init failed ({init_resp.status_code}): {str(getattr(init_resp, 'text', ''))[:240]}"
            )
        init_json = init_resp.json() or {}
        err_obj = init_json.get("error") or {}
        err_code = str(err_obj.get("code") or "ok").lower()
        if err_code not in ("", "ok"):
            raise MediaPublishError(f"TikTok API init error {err_code}: {err_obj.get('message')}")

        publish_id = str((init_json.get("data") or {}).get("publish_id") or "").strip()
        if not publish_id:
            raise MediaPublishError("TikTok video init returned empty publish_id")

        # Poll TikTok publish status
        external_post_id = publish_id
        post_url = None
        final_status = None
        for attempt in range(self.max_poll_attempts):
            st_resp = self.http.post(
                f"{DEFAULT_TIKTOK_API_BASE}/post/publish/status/fetch/",
                headers=headers,
                json={"publish_id": publish_id},
                timeout=self.timeout,
            )
            if st_resp.status_code != 200:
                raise MediaPublishError(
                    f"TikTok status/fetch failed ({st_resp.status_code}): {str(getattr(st_resp, 'text', ''))[:240]}"
                )
            st_data = (st_resp.json() or {}).get("data") or {}
            st_name = str(st_data.get("status") or "").strip().upper()
            if st_name == "PUBLISH_COMPLETE":
                final_status = st_name
                pub_ids = st_data.get("publicaly_available_post_id") or st_data.get("publicly_available_post_id") or []
                if isinstance(pub_ids, list) and pub_ids:
                    external_post_id = str(pub_ids[0])
                elif isinstance(pub_ids, str) and pub_ids:
                    external_post_id = pub_ids
                handle = str(account.get("account_handle") or "").strip().lstrip("@")
                if handle and external_post_id:
                    post_url = f"https://www.tiktok.com/@{handle}/video/{external_post_id}"
                break
            if st_name == "FAILED":
                raise MediaPublishError(
                    f"TikTok publish {publish_id} FAILED: {st_data.get('fail_reason')}"
                )
            if attempt + 1 < self.max_poll_attempts and self.poll_interval_seconds > 0:
                self._sleep(self.poll_interval_seconds)

        if final_status != "PUBLISH_COMPLETE":
            raise MediaPublishError(
                f"TikTok publish {publish_id} did not reach PUBLISH_COMPLETE within {self.max_poll_attempts} polls"
            )

        return {
            "platform": "TIKTOK",
            "channel": "TIKTOK",
            "publish_id": publish_id,
            "external_post_id": external_post_id,
            "post_url": post_url,
            "status": "PUBLISH_COMPLETE",
        }

    def publish_publication(
        self,
        *,
        publication: Dict[str, Any],
        render_version: Optional[Dict[str, Any]] = None,
        video_url: Optional[str] = None,
        caption: Optional[str] = None,
        account: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Publishes a publication to Instagram Reels or TikTok using the agency's Vault-backed
        `social_accounts` credentials and persists `external_post_id` & `post_url`.
        """
        channel = str(publication.get("channel") or "INSTAGRAM_REELS").strip().upper()
        platform = "TIKTOK" if channel == "TIKTOK" else "INSTAGRAM"
        agency_id = str(publication.get("agency_id") or "").strip()
        target_handle = publication.get("target_account_handle")

        resolved_account = account or fetch_active_social_account(
            self.repo, agency_id, platform, account_handle=target_handle
        )
        if not resolved_account:
            raise MediaPublishError(
                f"No active {platform} social_account configured for agency={agency_id or 'unknown'}"
            )

        resolved_url = self.resolve_media_url(video_url=video_url, render_version=render_version)
        final_caption = caption if caption is not None else str(publication.get("caption_used") or publication.get("notes") or "")

        if platform == "TIKTOK":
            result = self.publish_tiktok_video(resolved_account, resolved_url, final_caption)
        else:
            result = self.publish_instagram_reel(resolved_account, resolved_url, final_caption)

        pub_id = str(publication.get("id") or "").strip()
        listing_id = str(publication.get("listing_id") or "").strip()
        if pub_id and listing_id and hasattr(self.repo, "create_or_update_publication"):
            try:
                self.repo.create_or_update_publication(
                    listing_id=listing_id,
                    publication_id=pub_id,
                    status="PUBLISHED",
                    channel=channel,
                    post_url=result.get("post_url"),
                    external_post_id=result.get("external_post_id"),
                    telemetry_status="ACTIVE",
                )
            except Exception as exc:
                logger.warning("Failed updating publication %s after official publish: %s", pub_id, exc)

        return result

    def fetch_instagram_telemetry(
        self,
        account: Dict[str, Any],
        external_post_id: str,
    ) -> Dict[str, Any]:
        """Fetches official Instagram Reels metrics & comments via Meta Graph API."""
        secret_id = str(account.get("vault_secret_id") or "").strip()
        access_token = read_social_secret(self.repo, secret_id)
        base = f"https://graph.facebook.com/{self.graph_api_version}"

        media_resp = self.http.get(
            f"{base}/{external_post_id}",
            params={
                "fields": "like_count,comments_count,permalink",
                "access_token": access_token,
            },
            timeout=self.timeout,
        )
        if media_resp.status_code != 200:
            raise OfficialSocialError(
                f"Meta media telemetry failed ({media_resp.status_code}): {str(getattr(media_resp, 'text', ''))[:240]}"
            )
        media_data = media_resp.json() or {}
        likes_count = int(media_data.get("like_count") or 0)
        comments_count = int(media_data.get("comments_count") or 0)
        views_count = 0
        shares_count = 0

        # Insights (plays/shares) are best-effort for newly published Reels
        try:
            ins_resp = self.http.get(
                f"{base}/{external_post_id}/insights",
                params={"metric": "plays,shares,reach", "access_token": access_token},
                timeout=self.timeout,
            )
            if ins_resp.status_code == 200:
                for metric in (ins_resp.json() or {}).get("data") or []:
                    name = str(metric.get("name") or "").lower()
                    vals = metric.get("values") or []
                    val = int((vals[0] or {}).get("value") or 0) if vals else 0
                    if name == "plays":
                        views_count = max(views_count, val)
                    elif name == "reach" and views_count == 0:
                        views_count = val
                    elif name == "shares":
                        shares_count = max(shares_count, val)
        except Exception as exc:
            logger.debug("Meta insights lookup skipped for %s: %s", external_post_id, exc)

        comments: List[Dict[str, Any]] = []
        try:
            comm_resp = self.http.get(
                f"{base}/{external_post_id}/comments",
                params={
                    "fields": "id,username,text,timestamp,like_count",
                    "limit": "50",
                    "access_token": access_token,
                },
                timeout=self.timeout,
            )
            if comm_resp.status_code == 200:
                for row in (comm_resp.json() or {}).get("data") or []:
                    cid = str(row.get("id") or "").strip()
                    text = str(row.get("text") or "").strip()
                    handle = str(row.get("username") or "").strip().lstrip("@")
                    if cid and text and handle:
                        comments.append({
                            "comment_id": cid,
                            "author_handle": handle,
                            "comment_text": text,
                            "created_at": row.get("timestamp") or _utc_now().isoformat(),
                            "like_count": int(row.get("like_count") or 0),
                        })
        except Exception as exc:
            logger.debug("Meta comments lookup failed for %s: %s", external_post_id, exc)

        return {
            "platform": "INSTAGRAM",
            "views_count": views_count,
            "likes_count": likes_count,
            "comments_count": max(comments_count, len(comments)),
            "shares_count": shares_count,
            "comments": comments,
            "top_comments": comments,
        }

    def fetch_tiktok_telemetry(
        self,
        account: Dict[str, Any],
        external_post_id: str,
    ) -> Dict[str, Any]:
        """Fetches official TikTok video metrics via TikTok v2 `/video/query/`."""
        secret_id = str(account.get("vault_secret_id") or "").strip()
        access_token = read_social_secret(self.repo, secret_id)
        resp = self.http.post(
            f"{DEFAULT_TIKTOK_API_BASE}/video/query/",
            params={"fields": "id,title,view_count,like_count,comment_count,share_count,share_url"},
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            json={"filters": {"video_ids": [str(external_post_id).strip()]}},
            timeout=self.timeout,
        )
        if resp.status_code != 200:
            raise OfficialSocialError(
                f"TikTok video/query failed ({resp.status_code}): {str(getattr(resp, 'text', ''))[:240]}"
            )
        videos = ((resp.json() or {}).get("data") or {}).get("videos") or []
        vid = videos[0] if videos else {}
        return {
            "platform": "TIKTOK",
            "views_count": int(vid.get("view_count") or 0),
            "likes_count": int(vid.get("like_count") or 0),
            "comments_count": int(vid.get("comment_count") or 0),
            "shares_count": int(vid.get("share_count") or 0),
            "comments": [],
            "top_comments": [],
        }

    def fetch_telemetry(
        self,
        publication: Dict[str, Any],
        account: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Fetches official metrics and comments for a published Instagram or TikTok post."""
        external_post_id = str(publication.get("external_post_id") or "").strip()
        if not external_post_id:
            raise OfficialSocialError(
                f"Publication {publication.get('id')} missing external_post_id for OFFICIAL telemetry sync"
            )
        channel = str(publication.get("channel") or "INSTAGRAM_REELS").strip().upper()
        platform = "TIKTOK" if channel == "TIKTOK" else "INSTAGRAM"
        agency_id = str(publication.get("agency_id") or "").strip()
        resolved_account = account or fetch_active_social_account(
            self.repo,
            agency_id,
            platform,
            account_handle=publication.get("target_account_handle"),
        )
        if not resolved_account:
            raise OfficialSocialError(
                f"No active {platform} social_account for agency={agency_id or 'unknown'}"
            )
        if platform == "TIKTOK":
            return self.fetch_tiktok_telemetry(resolved_account, external_post_id)
        return self.fetch_instagram_telemetry(resolved_account, external_post_id)


def refresh_expiring_social_tokens(
    repo: Any,
    *,
    http_session: Optional[Any] = None,
    now: Optional[datetime] = None,
    tiktok_window_hours: int = 6,
    meta_window_days: int = 7,
    graph_api_version: str = DEFAULT_META_GRAPH_VERSION,
    meta_app_id: Optional[str] = None,
    meta_app_secret: Optional[str] = None,
    tiktok_client_key: Optional[str] = None,
    tiktok_client_secret: Optional[str] = None,
    timeout: int = 20,
) -> Dict[str, Any]:
    """
    Proactively refreshes expiring OAuth tokens stored in `public.social_accounts`:
    - TikTok tokens expire in 24h -> refreshed when within `tiktok_window_hours` (default 6h)
      via `POST https://open.tiktokapis.com/v2/oauth/token/` using `refresh_vault_secret_id`.
    - Meta/Instagram long-lived tokens expire in 60d -> refreshed when within `meta_window_days`
      (default 7d) via `GET https://graph.facebook.com/{version}/oauth/access_token` (`fb_exchange_token`).
    New secrets are persisted via `store_social_secret` Vault RPC and `social_accounts` is patched.
    """
    if not _is_real_repo_http(repo):
        return {"refreshed_count": 0, "skipped_count": 0, "failed_count": 0, "errors": []}

    current_dt = _utc_now(now)
    http = http_session or requests.Session()
    m_app_id = (meta_app_id if meta_app_id is not None else os.getenv("META_APP_ID", "")).strip()
    m_app_secret = (meta_app_secret if meta_app_secret is not None else os.getenv("META_APP_SECRET", "")).strip()
    t_client_key = (tiktok_client_key if tiktok_client_key is not None else os.getenv("TIKTOK_CLIENT_KEY", "")).strip()
    t_client_secret = (tiktok_client_secret if tiktok_client_secret is not None else os.getenv("TIKTOK_CLIENT_SECRET", "")).strip()

    resp = repo.session.get(
        _repo_rest_url(repo, "social_accounts"),
        headers=_repo_headers(repo),
        params={"is_active": "eq.true", "select": "*"},
        timeout=getattr(repo, "timeout", 20),
    )
    if resp.status_code != 200:
        raise SocialTokenRefreshError(
            f"Failed querying social_accounts ({resp.status_code}): {str(getattr(resp, 'text', ''))[:240]}"
        )
    accounts = resp.json() or []

    refreshed = 0
    skipped = 0
    failed = 0
    errors: List[str] = []

    for acc in accounts:
        if str(acc.get("status") or "ACTIVE").upper() != "ACTIVE":
            skipped += 1
            continue

        acc_id = str(acc.get("id") or "").strip()
        agency_id = str(acc.get("agency_id") or "").strip()
        platform = str(acc.get("platform") or "").strip().upper()
        handle = str(acc.get("account_handle") or acc_id).strip()
        expires_at = _parse_iso_dt(acc.get("token_expires_at"))

        window = timedelta(hours=tiktok_window_hours) if platform == "TIKTOK" else timedelta(days=meta_window_days)
        if expires_at is not None and expires_at > (current_dt + window):
            skipped += 1
            continue

        try:
            if platform == "TIKTOK":
                refresh_secret_id = str(acc.get("refresh_vault_secret_id") or "").strip()
                if not refresh_secret_id:
                    raise SocialTokenRefreshError(f"TikTok account {acc_id} missing refresh_vault_secret_id")
                refresh_tok = read_social_secret(repo, refresh_secret_id)
                tok_resp = http.post(
                    f"{DEFAULT_TIKTOK_API_BASE}/oauth/token/",
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    data={
                        "client_key": t_client_key,
                        "client_secret": t_client_secret,
                        "grant_type": "refresh_token",
                        "refresh_token": refresh_tok,
                    },
                    timeout=timeout,
                )
                if tok_resp.status_code != 200:
                    raise SocialTokenRefreshError(
                        f"TikTok token refresh failed ({tok_resp.status_code}): {str(getattr(tok_resp, 'text', ''))[:200]}"
                    )
                tok_data = tok_resp.json() or {}
                new_access = str(tok_data.get("access_token") or "").strip()
                new_refresh = str(tok_data.get("refresh_token") or "").strip()
                expires_in = int(tok_data.get("expires_in") or 86400)
                if not new_access:
                    raise SocialTokenRefreshError("TikTok refresh response missing access_token")

                new_vault_id = store_social_secret(repo, f"tiktok_access_{agency_id}_{handle}", new_access)
                patch: Dict[str, Any] = {
                    "vault_secret_id": new_vault_id,
                    "token_expires_at": (current_dt + timedelta(seconds=expires_in)).isoformat(),
                }
                if new_refresh:
                    patch["refresh_vault_secret_id"] = store_social_secret(
                        repo, f"tiktok_refresh_{agency_id}_{handle}", new_refresh
                    )
            elif platform == "INSTAGRAM":
                vault_secret_id = str(acc.get("vault_secret_id") or "").strip()
                if not vault_secret_id:
                    raise SocialTokenRefreshError(f"Instagram account {acc_id} missing vault_secret_id")
                cur_tok = read_social_secret(repo, vault_secret_id)
                ex_resp = http.get(
                    f"https://graph.facebook.com/{graph_api_version}/oauth/access_token",
                    params={
                        "grant_type": "fb_exchange_token",
                        "client_id": m_app_id,
                        "client_secret": m_app_secret,
                        "fb_exchange_token": cur_tok,
                    },
                    timeout=timeout,
                )
                if ex_resp.status_code != 200:
                    raise SocialTokenRefreshError(
                        f"Meta token exchange failed ({ex_resp.status_code}): {str(getattr(ex_resp, 'text', ''))[:200]}"
                    )
                ex_data = ex_resp.json() or {}
                new_access = str(ex_data.get("access_token") or "").strip()
                expires_in = int(ex_data.get("expires_in") or (60 * 86400))
                if not new_access:
                    raise SocialTokenRefreshError("Meta refresh response missing access_token")

                new_vault_id = store_social_secret(repo, f"instagram_access_{agency_id}_{handle}", new_access)
                patch = {
                    "vault_secret_id": new_vault_id,
                    "token_expires_at": (current_dt + timedelta(seconds=expires_in)).isoformat(),
                }
            else:
                skipped += 1
                continue

            patch_resp = repo.session.patch(
                _repo_rest_url(repo, "social_accounts"),
                headers=_repo_headers(repo, prefer="return=representation"),
                params={"id": f"eq.{acc_id}"},
                json=patch,
                timeout=getattr(repo, "timeout", 20),
            )
            if patch_resp.status_code not in (200, 204):
                raise SocialTokenRefreshError(
                    f"Failed updating social_accounts {acc_id} ({patch_resp.status_code})"
                )
            refreshed += 1
        except Exception as exc:
            failed += 1
            errors.append(f"{platform}:{handle}: {exc}")
            logger.warning("Token refresh failed for %s (%s): %s", handle, acc_id, exc)

    return {
        "refreshed_count": refreshed,
        "skipped_count": skipped,
        "failed_count": failed,
        "errors": errors,
    }
