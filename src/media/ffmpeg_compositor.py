"""
1080x1920 (9:16) vertical video compositor.
Generates social media videos for real estate listings with:
- Blurred background (boxblur=25:5) + sharp centered foreground (4:3 aspect ratio preserved, no distortion)
- Golden price banner (#F59E0B)
- Green Kupça badge (#10B981)
- Location banner
- Burned-in dynamic karaoke subtitles
- Audio auto-ducking for background music + voiceover
- Ken Burns dynamic pan/zoom slideshow engine
"""

import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import os
import shutil
import logging
import subprocess
import tempfile
from pathlib import Path
from typing import List, Dict, Any, Optional

from config.settings import (
    VIDEO_WIDTH,
    VIDEO_HEIGHT,
    FPS,
    SLIDE_DURATION,
    COLOR_GOLDEN_BANNER,
    COLOR_KUPCA_BADGE,
    OUTPUT_DIR
)

logger = logging.getLogger("ffmpeg_compositor")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def get_ffmpeg_executable() -> str:
    """Finds available FFmpeg binary from imageio-ffmpeg or system PATH."""
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and Path(exe).exists():
            return exe
    except Exception:
        pass

    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg

    raise RuntimeError("FFmpeg executable not found. Please ensure imageio-ffmpeg is installed.")


def escape_ffmpeg_path(path: Path) -> str:
    """Escapes file path for FFmpeg filter syntax, especially for Windows paths."""
    posix_path = str(path.resolve()).replace("\\", "/")
    if ":" in posix_path:
        drive, rest = posix_path.split(":", 1)
        return f"{drive}\\:{rest}"
    return posix_path


def sanitize_text(text: str) -> str:
    """Sanitizes text for FFmpeg drawtext filter string escaping."""
    if not text:
        return ""
    # Remove chars that break ffmpeg filter syntax
    sanitized = text.replace("'", "").replace(":", " ").replace("%", "%%").replace("\\", "/")
    return sanitized.strip()


class VideoCompositor:
    def __init__(self, ffmpeg_path: Optional[str] = None):
        self.ffmpeg_exe = ffmpeg_path or get_ffmpeg_executable()
        logger.info(f"Initialized VideoCompositor with FFmpeg: {self.ffmpeg_exe}")

    def create_single_slide(
        self,
        image_path: Path,
        output_clip_path: Path,
        duration: float,
        zoom_direction: str = "in"
    ) -> None:
        """
        Creates a 1080x1920 slide video from a single photo with:
        - Blurred background (boxblur=25:5)
        - Sharp centered foreground (maintaining aspect ratio, max 1080x1440)
        - Subtle Ken Burns pan/zoom effect
        """
        total_frames = max(1, int(duration * FPS))
        zoom_step = 0.12 / total_frames

        # Smooth, continuous Ken Burns zoom scaled to exact slide duration
        if zoom_direction == "in":
            zoom_expr = f"min(1.0+on*{zoom_step:.6f},1.12)"
        else:
            zoom_expr = f"max(1.12-on*{zoom_step:.6f},1.0)"

        filter_graph = (
            # 1. Background: scale to vertical frame, crop to 1080x1920, heavy boxblur
            f"[0:v]scale={VIDEO_WIDTH}:{VIDEO_HEIGHT}:force_original_aspect_ratio=increase,"
            f"crop={VIDEO_WIDTH}:{VIDEO_HEIGHT},boxblur=25:5[bg];"
            # 2. Foreground: scale preserving original aspect ratio with guaranteed even dimensions
            f"[0:v]scale={VIDEO_WIDTH}:-2:force_original_aspect_ratio=decrease[fg];"
            # 3. Overlay sharp foreground on top of blurred background, centered vertically
            f"[bg][fg]overlay=(W-w)/2:(H-h)/2[merged];"
            # 4. Subtle Ken Burns zoompan on composite
            f"[merged]zoompan=z='{zoom_expr}':d={total_frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={VIDEO_WIDTH}x{VIDEO_HEIGHT}:fps={FPS}[out]"
        )

        cmd = [
            self.ffmpeg_exe, "-y",
            "-loop", "1",
            "-i", str(image_path),
            "-filter_complex", filter_graph,
            "-map", "[out]",
            "-t", str(duration),
            "-r", str(FPS),
            "-pix_fmt", "yuv420p",
            "-c:v", "libx264",
            "-preset", "faster",
            str(output_clip_path)
        ]

        logger.debug(f"Rendering slide clip: {' '.join(cmd)}")
        res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if res.returncode != 0:
            logger.error(f"Failed to render slide clip {image_path}: {res.stderr[-400:]}")
            raise RuntimeError(f"FFmpeg slide rendering failed for {image_path}")

    def build_video(
        self,
        listing: Dict[str, Any],
        image_paths: List[str],
        audio_path: str,
        srt_path: str,
        output_video_path: Path,
        bg_music_path: Optional[str] = None,
        duration: Optional[float] = None
    ) -> Path:
        """
        Orchestrates full video compilation:
        1. Calculates duration per slide.
        2. Renders Ken Burns slide clips for all photos.
        3. Concatenates slides.
        4. Overlays Golden Price Banner, Kupça badge, Location banner, and dynamic subtitles.
        5. Mixes voiceover audio (with auto-ducked background music if provided).
        6. Produces final 1080x1920 MP4 video.
        """
        if not image_paths:
            raise ValueError("At least one image path is required to compose video.")

        output_video_path.parent.mkdir(parents=True, exist_ok=True)
        temp_dir = Path(tempfile.mkdtemp(prefix="estate_comp_"))

        try:
            # Determine audio duration if not explicitly passed
            total_duration = duration
            if not total_duration or total_duration <= 0:
                total_duration = self._probe_audio_duration(Path(audio_path))
            if total_duration <= 0:
                total_duration = len(image_paths) * SLIDE_DURATION

            num_images = len(image_paths)
            slide_duration = max(2.5, total_duration / num_images)
            logger.info(f"Total duration: {total_duration:.2f}s across {num_images} slides ({slide_duration:.2f}s each)")

            # Render individual slide clips
            slide_clips = []
            for idx, img_p in enumerate(image_paths):
                clip_path = temp_dir / f"slide_{idx:02d}.mp4"
                zoom_dir = "in" if idx % 2 == 0 else "out"
                self.create_single_slide(Path(img_p), clip_path, slide_duration, zoom_direction=zoom_dir)
                slide_clips.append(clip_path)

            # Create concat list file
            concat_txt = temp_dir / "concat_list.txt"
            with open(concat_txt, "w", encoding="utf-8") as f:
                for clip in slide_clips:
                    posix_clip = str(clip.resolve()).replace("\\", "/")
                    f.write(f"file '{posix_clip}'\n")

            # Prepare concatenated video without audio
            concatenated_raw = temp_dir / "concatenated_raw.mp4"
            concat_cmd = [
                self.ffmpeg_exe, "-y",
                "-f", "concat",
                "-safe", "0",
                "-i", str(concat_txt),
                "-c", "copy",
                str(concatenated_raw)
            ]
            subprocess.run(concat_cmd, check=True, capture_output=True)

            # Prepare overlays
            price = listing.get("price")
            curr = listing.get("currency") or "AZN"
            try:
                num_price = float(price) if price is not None else 0.0
                formatted_price = f"{int(num_price):,}".replace(",", " ") if num_price > 0 else "Münasib Qiymət"
            except (ValueError, TypeError):
                formatted_price = "Münasib Qiymət"
            price_text = sanitize_text(f"QIYMƏT: {formatted_price} {curr}")

            loc_text = sanitize_text(listing.get("location") or listing.get("address") or "Bakı şəhəri")
            rooms = listing.get("rooms")
            area = listing.get("area")
            param_parts = []
            if rooms:
                param_parts.append(f"{rooms} otaqlı")
            if area:
                param_parts.append(f"{int(area)} m²")
            param_str = " | ".join(param_parts)
            loc_banner_text = sanitize_text(f"📍 {loc_text}" + (f"  ({param_str})" if param_str else ""))

            # Subtitle filter string
            escaped_srt = escape_ffmpeg_path(Path(srt_path))

            # Build final filtergraph for banners & subtitles
            filter_chains = []

            # 1. Hook Badge: First 3.2 seconds high-urgency red/gold badge
            filter_chains.append(
                f"drawbox=y=70:color=0xDC2626@0.92:width=iw:height=65:t=fill:enable='between(t,0,3.2)',"
                f"drawtext=text='🔥 TƏCİLİ KUPÇALI SATIŞ':fontcolor=white:fontsize=32:x=(w-text_w)/2:y=86:enable='between(t,0,3.2)'"
            )

            # 2. Golden Price Banner (y=150, height=90, golden color 0xF59E0B)
            filter_chains.append(
                f"drawbox=y=150:color=0xF59E0B@0.95:width=iw:height=90:t=fill,"
                f"drawtext=text='{price_text}':fontcolor=0x111827:fontsize=44:x=(w-text_w)/2:y=173"
            )

            # 3. Emerald Green Kupça Badge (if listing has bill of sale)
            if listing.get("has_bill_of_sale", True):
                filter_chains.append(
                    f"drawbox=x=80:y=255:width=420:height=65:color=0x10B981@0.95:t=fill,"
                    f"drawtext=text='✓ KUPCALI / CIXARISLI':fontcolor=white:fontsize=30:x=105:y=273"
                )

            # 4. Location Banner
            filter_chains.append(
                f"drawbox=y=335:color=0x0F172A@0.85:width=iw:height=65:t=fill,"
                f"drawtext=text='{loc_banner_text}':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=353"
            )

            # 5. Burned Subtitles: High-contrast TikTok viral yellow font (&H0000FFFF) with strong outline
            filter_chains.append(
                f"subtitles='{escaped_srt}':force_style='FontSize=28,Bold=1,PrimaryColour=&H0000FFFF,"
                f"OutlineColour=&H00000000,BorderStyle=3,Outline=2.8,Shadow=1.5,Alignment=2,MarginV=210'"
            )

            final_vf = ",".join(filter_chains)

            # Resolve background music and sound effects
            resolved_bg_music = bg_music_path
            if not resolved_bg_music or not Path(resolved_bg_music).exists():
                fallback_music = Path(__file__).resolve().parent.parent.parent / "assets" / "music" / "luxury_beat.mp3"
                if fallback_music.exists():
                    resolved_bg_music = str(fallback_music)

            chime_sfx = Path(__file__).resolve().parent.parent.parent / "assets" / "sfx" / "chime.mp3"

            cmd = [
                self.ffmpeg_exe, "-y",
                "-i", str(concatenated_raw),
                "-i", str(audio_path)
            ]

            if resolved_bg_music and Path(resolved_bg_music).exists():
                cmd.extend(["-stream_loop", "-1", "-i", str(resolved_bg_music)])
                fade_start = max(1.0, total_duration - 1.2)

                if chime_sfx.exists():
                    cmd.extend(["-i", str(chime_sfx)])
                    audio_filter = (
                        f"[2:a]volume=0.22,lowpass=f=3800[bg_pre];"
                        f"[bg_pre][1:a]sidechaincompress=threshold=0.08:ratio=5:attack=30:release=350[ducked_bg];"
                        f"[3:a]adelay=500|500,volume=0.35[sfx_chime];"
                        f"[ducked_bg][1:a][sfx_chime]amix=inputs=3:normalize=0[amixed];"
                        f"[amixed]afade=t=out:st={fade_start:.2f}:d=1.2[aout]"
                    )
                else:
                    audio_filter = (
                        f"[2:a]volume=0.22,lowpass=f=3800[bg_pre];"
                        f"[bg_pre][1:a]sidechaincompress=threshold=0.08:ratio=5:attack=30:release=350[ducked_bg];"
                        f"[ducked_bg][1:a]amix=inputs=2:normalize=0[amixed];"
                        f"[amixed]afade=t=out:st={fade_start:.2f}:d=1.2[aout]"
                    )

                cmd.extend([
                    "-filter_complex", f"[0:v]{final_vf}[vout];{audio_filter}",
                    "-map", "[vout]",
                    "-map", "[aout]"
                ])
            else:
                cmd.extend([
                    "-vf", final_vf,
                    "-map", "0:v",
                    "-map", "1:a"
                ])

            cmd.extend([
                "-t", str(total_duration),
                "-c:v", "libx264",
                "-preset", "faster",
                "-pix_fmt", "yuv420p",
                "-b:v", "3500k",
                "-c:a", "aac",
                "-b:a", "192k",
                str(output_video_path)
            ])

            logger.info(f"Rendering final composite video -> {output_video_path}...")
            res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
            if res.returncode != 0:
                logger.error(f"FFmpeg composite failed: {res.stderr[-500:]}")
                raise RuntimeError(f"FFmpeg composite failed: {res.stderr[-300:]}")


            logger.info(f"Successfully rendered video: {output_video_path} ({output_video_path.stat().st_size} bytes)")
            return output_video_path

        finally:
            # Clean up temp folder
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception:
                pass

    def _probe_audio_duration(self, audio_path: Path) -> float:
        """Determines duration of audio file using ffprobe/ffmpeg."""
        try:
            cmd = [
                self.ffmpeg_exe, "-i", str(audio_path)
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
            # Find Duration: 00:00:15.24
            import re
            m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", res.stderr)
            if m:
                hours = int(m.group(1))
                minutes = int(m.group(2))
                seconds = float(m.group(3))
                return hours * 3600 + minutes * 60 + seconds
        except Exception as e:
            logger.warning(f"Could not probe audio duration: {e}")
        return 0.0
