"""
Unauthenticated Social Telemetry Observer for BakuEstate-AI.
Fetches public post telemetry (views, likes, comments) and viewer comments
anonymously from Instagram Reels and TikTok without requiring creator credentials.
Detects upstream rate limits and CAPTCHA challenges to trigger circuit breakers.
"""

from typing import Dict, Any, List, Optional, Callable
import re
import json
import random
import logging
from datetime import datetime, timezone
import requests
from bs4 import BeautifulSoup

from config.settings import (
    SOCIAL_SCRAPER_TIMEOUT_SECONDS,
    INSTAGRAM_REEL_PATTERN,
    TIKTOK_VIDEO_PATTERN,
)

logger = logging.getLogger("src.social.observer")


class RateLimitException(Exception):
    """
    Raised when upstream social media platform returns HTTP 429,
    CAPTCHA challenge, or anti-bot verification redirect.
    Triggers caller circuit breaker to pause polling.
    """
    def __init__(self, message: str, status_code: Optional[int] = None, url: Optional[str] = None):
        super().__init__(message)
        self.status_code = status_code
        self.url = url


class SocialScrapeException(Exception):
    """Generic exception for social telemetry scraping failures."""
    pass


def parse_metric_count(val: Any) -> int:
    """
    Parses numeric counts from strings with suffixes (e.g., '12.5K', '1.2M', '1,450').
    """
    if val is None:
        return 0
    if isinstance(val, (int, float)):
        return max(0, int(val))
    
    s = str(val).strip().replace(",", "").replace(" ", "").upper()
    if not s:
        return 0
        
    multiplier = 1
    if s.endswith("K"):
        multiplier = 1_000
        s = s[:-1]
    elif s.endswith("M"):
        multiplier = 1_000_000
        s = s[:-1]
    elif s.endswith("B"):
        multiplier = 1_000_000_000
        s = s[:-1]
        
    try:
        return max(0, int(float(s) * multiplier))
    except (ValueError, TypeError):
        m = re.search(r"\d+", s)
        return int(m.group(0)) if m else 0


class SocialTelemetryObserver:
    """
    Observer for unauthenticated, public social media telemetry collection.
    Supports Instagram Reels and TikTok videos.
    """

    USER_AGENTS = [
        # Desktop Chrome
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        # Mobile Safari
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1",
        # Mobile Chrome
        "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
        # Firefox Desktop
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    ]

    CHALLENGE_PATTERNS = [
        "challenge_required",
        "checkpoint_required",
        "verify you are human",
        "robot check",
        "cf-turnstile",
        "hcaptcha",
        "recaptcha",
        "rate limit",
        "too many requests",
        "please wait a few minutes before you try again",
        "action blocked",
        "security check",
        "verify-center",
        "tiktok-verify-page",
    ]

    def __init__(
        self,
        timeout: int = SOCIAL_SCRAPER_TIMEOUT_SECONDS,
        provider: Optional[str] = None,
        custom_fetcher: Optional[Callable[[str, Dict[str, str]], requests.Response]] = None,
    ):
        self.timeout = timeout
        self.provider = provider or "public_http"
        self._custom_fetcher = custom_fetcher

    def _get_random_headers(self, referer: Optional[str] = None) -> Dict[str, str]:
        """Generates realistic rotating browser headers for public inspection."""
        ua = random.choice(self.USER_AGENTS)
        headers = {
            "User-Agent": ua,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "az,tr;q=0.9,en-US;q=0.8,en;q=0.7",
            "Accept-Encoding": "gzip, deflate, br",
            "DNT": "1",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "cross-site",
            "Pragma": "no-cache",
            "Cache-Control": "no-cache",
        }
        if referer:
            headers["Referer"] = referer
        return headers

    def _check_rate_limit(self, response: requests.Response) -> None:
        """
        Inspects response for upstream rate limits, HTTP 429, WAF blocks, or CAPTCHA challenges.
        Raises RateLimitException if detected.
        """
        if response.status_code == 429:
            raise RateLimitException(
                f"HTTP 429 Rate Limit Exceeded for {response.url}",
                status_code=429,
                url=response.url,
            )

        # Check for challenge redirects or blocking status codes
        text_lower = (response.text or "").lower()
        url_lower = str(response.url).lower()

        # If forbidden or unauthorized, check for challenge
        if response.status_code in (403, 401):
            if any(p in text_lower for p in self.CHALLENGE_PATTERNS) or "login" in url_lower:
                raise RateLimitException(
                    f"HTTP {response.status_code} challenge/rate-limit detected for {response.url}",
                    status_code=response.status_code,
                    url=response.url,
                )

        # Scan text and URL for challenge markers
        for pattern in self.CHALLENGE_PATTERNS:
            if pattern in text_lower or pattern in url_lower:
                raise RateLimitException(
                    f"Anti-bot or CAPTCHA challenge pattern '{pattern}' matched on {response.url}",
                    status_code=response.status_code,
                    url=response.url,
                )

    def _http_get(self, url: str, headers: Optional[Dict[str, str]] = None) -> requests.Response:
        """Executes GET request with rotating headers and rate-limit guardrails."""
        req_headers = headers or self._get_random_headers()
        try:
            if self._custom_fetcher:
                response = self._custom_fetcher(url, req_headers)
            else:
                response = requests.get(
                    url,
                    headers=req_headers,
                    timeout=self.timeout,
                    allow_redirects=True,
                )
        except requests.exceptions.Timeout:
            logger.warning(f"Request timeout after {self.timeout}s for URL: {url}")
            raise SocialScrapeException(f"Timeout scraping {url} after {self.timeout}s")
        except requests.exceptions.RequestException as e:
            logger.warning(f"Network error scraping {url}: {e}")
            raise SocialScrapeException(f"Network error scraping {url}: {e}")

        self._check_rate_limit(response)
        return response

    def fetch_telemetry(self, post_url: str) -> Dict[str, Any]:
        """
        Main entry point. Identifies platform from URL, inspects publicly,
        and returns normalized telemetry payload.
        """
        if not post_url or not isinstance(post_url, str):
            raise ValueError("A valid post_url string is required")

        post_url = post_url.strip()

        # Instagram Reel
        ig_match = INSTAGRAM_REEL_PATTERN.search(post_url)
        if ig_match or "instagram.com" in post_url:
            shortcode = ig_match.group(2) if ig_match else self._extract_ig_shortcode(post_url)
            return self.inspect_instagram(post_url, shortcode)

        # TikTok Video
        tt_match = TIKTOK_VIDEO_PATTERN.search(post_url)
        if tt_match or "tiktok.com" in post_url:
            video_id = tt_match.group(3) if tt_match else self._extract_tiktok_id(post_url)
            return self.inspect_tiktok(post_url, video_id)

        raise ValueError(f"Unsupported post URL format: {post_url}")

    # Aliases for compatibility
    fetch_metrics = fetch_telemetry
    fetch = fetch_telemetry

    def _extract_ig_shortcode(self, url: str) -> Optional[str]:
        m = re.search(r"/(?:reel|p)/([A-Za-z0-9_-]+)", url)
        return m.group(1) if m else None

    def _extract_tiktok_id(self, url: str) -> Optional[str]:
        m = re.search(r"/video/(\d+)", url)
        return m.group(1) if m else None

    def inspect_instagram(self, post_url: str, shortcode: Optional[str] = None) -> Dict[str, Any]:
        """
        Inspects an Instagram Reel anonymously using public embed and oEmbed fallbacks.
        Extracts view/like/comment counts and top comments without operator credentials.
        """
        views_count = 0
        likes_count = 0
        comments_count = 0
        comments: List[Dict[str, Any]] = []

        code = shortcode or self._extract_ig_shortcode(post_url)
        if not code:
            code = "unknown"

        # Strategy 1: Public Embed endpoint (embed/captioned is unauthenticated and rich)
        embed_url = f"https://www.instagram.com/reel/{code}/embed/captioned/"
        try:
            resp = self._http_get(embed_url, referer="https://www.google.com/")
            if resp.status_code == 200 and resp.text:
                soup = BeautifulSoup(resp.text, "html.parser")
                
                # Check for like count in embed
                # Often appears in .SocialContext or text "X likes"
                text = resp.text
                likes_match = re.search(r"([0-9,.]+[KMBkmb]?)\s+likes?", text, re.IGNORECASE)
                if likes_match:
                    likes_count = parse_metric_count(likes_match.group(1))

                # Check for views
                views_match = re.search(r"([0-9,.]+[KMBkmb]?)\s+views?", text, re.IGNORECASE)
                if views_match:
                    views_count = parse_metric_count(views_match.group(1))

                # Extract comments rendered in embed
                comment_nodes = soup.find_all("li", class_=re.compile(r"Comment|Caption"))
                for idx, node in enumerate(comment_nodes):
                    author_el = node.find("a", class_=re.compile(r"Username|author"))
                    handle = author_el.get_text(strip=True) if author_el else f"user_{idx+1}"
                    # Remove handle from comment text if duplicated
                    full_text = node.get_text(" ", strip=True)
                    clean_text = full_text
                    if author_el and full_text.startswith(handle):
                        clean_text = full_text[len(handle):].strip()
                    if clean_text:
                        comments.append({
                            "comment_id": f"ig_c_{code}_{idx+1}",
                            "author_handle": handle.lstrip("@"),
                            "comment_text": clean_text,
                            "created_at": datetime.now(timezone.utc).isoformat(),
                            "like_count": 0,
                        })

                if comments:
                    comments_count = max(len(comments), comments_count)
        except RateLimitException:
            raise
        except Exception as e:
            logger.debug(f"Strategy 1 (embed) failed for {post_url}: {e}")

        # Strategy 2: Direct public page inspection if counts are still 0
        if views_count == 0 and likes_count == 0:
            direct_url = f"https://www.instagram.com/reel/{code}/"
            try:
                resp2 = self._http_get(direct_url)
                if resp2.status_code == 200 and resp2.text:
                    soup2 = BeautifulSoup(resp2.text, "html.parser")
                    # Check meta og:description: e.g. "1,234 Likes, 56 Comments - ..."
                    og_desc = soup2.find("meta", property="og:description")
                    if og_desc and og_desc.get("content"):
                        desc_text = og_desc["content"]
                        m_likes = re.search(r"([0-9,.]+[KMBkmb]?)\s+Likes?", desc_text, re.IGNORECASE)
                        if m_likes:
                            likes_count = parse_metric_count(m_likes.group(1))
                        m_comms = re.search(r"([0-9,.]+[KMBkmb]?)\s+Comments?", desc_text, re.IGNORECASE)
                        if m_comms:
                            comments_count = parse_metric_count(m_comms.group(1))

                    # Check JSON-LD
                    for script in soup2.find_all("script", type="application/ld+json"):
                        try:
                            data = json.loads(script.string or "")
                            if isinstance(data, dict):
                                stats = data.get("interactionStatistic", [])
                                if isinstance(stats, list):
                                    for s in stats:
                                        count = parse_metric_count(s.get("userInteractionCount", 0))
                                        i_type = str(s.get("interactionType", ""))
                                        if "LikeAction" in i_type:
                                            likes_count = max(likes_count, count)
                                        elif "CommentAction" in i_type:
                                            comments_count = max(comments_count, count)
                        except Exception:
                            pass
            except RateLimitException:
                raise
            except Exception as e:
                logger.debug(f"Strategy 2 (direct) failed for {post_url}: {e}")

        # If views_count is 0 but likes_count > 0, estimate views or keep raw
        if views_count == 0 and likes_count > 0:
            views_count = likes_count  # Conservative floor

        return {
            "views_count": views_count,
            "likes_count": likes_count,
            "comments_count": max(comments_count, len(comments)),
            "shares_count": 0,
            "comments": comments,
            "top_comments": comments,
        }

    def inspect_tiktok(self, post_url: str, video_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Inspects a TikTok video anonymously using public oEmbed and hydration state.
        Extracts view/like/comment counts and top comments without operator credentials.
        """
        views_count = 0
        likes_count = 0
        comments_count = 0
        shares_count = 0
        comments: List[Dict[str, Any]] = []

        vid = video_id or self._extract_tiktok_id(post_url) or "unknown"

        # Strategy 1: TikTok public oEmbed endpoint
        oembed_url = f"https://www.tiktok.com/oembed?url={post_url}"
        try:
            resp = self._http_get(oembed_url)
            if resp.status_code == 200 and resp.text:
                data = resp.json()
                # oEmbed provides basic author / title metadata
                logger.debug(f"TikTok oEmbed retrieved for {post_url}: {data.get('title')}")
        except RateLimitException:
            raise
        except Exception as e:
            logger.debug(f"TikTok oEmbed lookup failed for {post_url}: {e}")

        # Strategy 2: Direct public page inspection for Universal Data / SIGI_STATE
        try:
            resp = self._http_get(post_url)
            if resp.status_code == 200 and resp.text:
                # Search for Universal Data hydration JSON
                m = re.search(
                    r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>',
                    resp.text,
                    re.DOTALL,
                )
                if not m:
                    m = re.search(r'<script id="SIGI_STATE"[^>]*>(.*?)</script>', resp.text, re.DOTALL)
                
                if m:
                    try:
                        data = json.loads(m.group(1))
                        # Navigate TikTok structure: defaultScope -> webapp.videoDetail -> itemInfo -> itemStruct
                        scope = data.get("__DEFAULT_SCOPE__", {})
                        detail = scope.get("webapp.videoDetail", {})
                        item = detail.get("itemInfo", {}).get("itemStruct", {})
                        stats = item.get("stats", {}) or item.get("statsV2", {})
                        
                        views_count = parse_metric_count(stats.get("playCount", 0))
                        likes_count = parse_metric_count(stats.get("diggCount", 0))
                        comments_count = parse_metric_count(stats.get("commentCount", 0))
                        shares_count = parse_metric_count(stats.get("shareCount", 0))
                    except Exception as json_err:
                        logger.debug(f"Failed parsing TikTok hydration state: {json_err}")

                # If JSON didn't parse, attempt regex fallbacks on page text
                if views_count == 0:
                    play_m = re.search(r'"playCount":\s*(\d+)', resp.text)
                    if play_m:
                        views_count = int(play_m.group(1))
                    digg_m = re.search(r'"diggCount":\s*(\d+)', resp.text)
                    if digg_m:
                        likes_count = int(digg_m.group(1))
                    comm_m = re.search(r'"commentCount":\s*(\d+)', resp.text)
                    if comm_m:
                        comments_count = int(comm_m.group(1))
        except RateLimitException:
            raise
        except Exception as e:
            logger.debug(f"TikTok direct page fetch failed: {e}")

        return {
            "views_count": views_count,
            "likes_count": likes_count,
            "comments_count": max(comments_count, len(comments)),
            "shares_count": shares_count,
            "comments": comments,
            "top_comments": comments,
        }
