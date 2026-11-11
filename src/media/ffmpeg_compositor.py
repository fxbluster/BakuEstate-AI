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
import re
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


def get_windows_font_path(bold: bool = True) -> str:
    """Returns escaped Windows TTF font path with full Azerbaijani Unicode support."""
    candidates = [
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c.replace(":", "\\:")
    return ""


def convert_srt_to_ass(srt_path: Path, ass_path: Path) -> Path:
    """
    Converts an SRT subtitle file to a 1080x1920 ASS subtitle file.
    Places subtitles in the safe zone (MarginV=420) with high-contrast
    TikTok viral yellow font, black outline, and NO opaque black boxes.
    """
    ass_header = """[Script Info]
Title: Baku Estate AI Subtitles
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ModernSub,Segoe UI,54,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3.8,1.8,2,60,60,420,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    dialogues = []
    if srt_path.exists():
        content = srt_path.read_text(encoding="utf-8")
        blocks = re.split(r'\n\s*\n', content.strip())
        for block in blocks:
            lines = [l.strip() for l in block.splitlines() if l.strip()]
            if len(lines) >= 3 and "-->" in lines[1]:
                m = re.match(r'(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)', lines[1])
                if m:
                    sh, sm, ss, sms, eh, em, es, ems = m.groups()
                    start_ass = f"{int(sh)}:{sm}:{ss}.{sms[:2]}"
                    end_ass = f"{int(eh)}:{em}:{es}.{ems[:2]}"
                    text = " ".join(lines[2:])
                    dialogues.append(f"Dialogue: 0,{start_ass},{end_ass},ModernSub,,0,0,0,,{text}")

    with open(ass_path, "w", encoding="utf-8") as f:
        f.write(ass_header + "\n".join(dialogues) + "\n")
    return ass_path


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

            # Fonts
            font_bold = get_windows_font_path(bold=True)
            font_reg = get_windows_font_path(bold=False)

            # Location formatting and clean abbreviation expansion
            raw_loc = listing.get("location") or listing.get("address") or "Bakı şəhəri"
            loc_clean = re.sub(r'\bq\.(?=\s|$|[,\.!])', 'qəsəbəsi', raw_loc, flags=re.IGNORECASE).strip()
            loc_clean = re.sub(r'\bm\.(?=\s|$|[,\.!])', 'metrosu', loc_clean, flags=re.IGNORECASE).strip()
            loc_clean = re.sub(r'\bküç\.(?=\s|$|[,\.!])', 'küçəsi', loc_clean, flags=re.IGNORECASE).strip()
            loc_clean = re.sub(r'\bpr\.(?=\s|$|[,\.!])', 'prospekti', loc_clean, flags=re.IGNORECASE).strip()

            price = listing.get("price")
            curr = listing.get("currency") or "AZN"
            try:
                num_price = float(price) if price is not None else 0.0
                formatted_price = f"{int(num_price):,}".replace(",", " ") if num_price > 0 else "Münasib Qiymət"
            except (ValueError, TypeError):
                formatted_price = "Münasib Qiymət"
            price_display = sanitize_text(f"QIYMƏT: {formatted_price} {curr}")

            rooms = listing.get("rooms")
            area = listing.get("area")
            specs_parts = [loc_clean]
            if rooms:
                specs_parts.append(f"{rooms} otaq")
            if area:
                try:
                    specs_parts.append(f"{int(float(area))} m²")
                except Exception:
                    specs_parts.append(f"{area} m²")
            specs_display = sanitize_text("  •  ".join(specs_parts))

            # Phone / CTA line
            owner_phone = listing.get("owner_phone") or listing.get("phone") or ""
            if owner_phone:
                cta_line2 = sanitize_text(f"ƏLAQƏ / WHATSAPP: {owner_phone}")
            else:
                cta_line2 = sanitize_text("ƏLAQƏ / WHATSAPP ÜÇÜN DM YAZIN")
            cta_line1 = sanitize_text("BİRBAŞA SAHİBİNDƏN  •  KOMİSSİYASIZ")

            # Convert SRT to modern ASS for safe-zone burned subtitles
            ass_path = temp_dir / "subtitles_styled.ass"
            convert_srt_to_ass(Path(srt_path), ass_path)
            escaped_ass = escape_ffmpeg_path(ass_path)

            # Build final filtergraph with Unified Luxury Card & Bottom Contact Card
            filter_chains = []

            # 1. Unified Luxury Header Card (x=50, y=70, w=980, h=250)
            filter_chains.append(
                f"drawbox=x=50:y=70:width=980:height=250:color=0x0F172A@0.88:t=fill,"
                f"drawbox=x=50:y=70:width=980:height=250:color=0xF59E0B@0.45:t=3"
            )

            # 2. Badges: Urgent red pill + Kupça green pill
            has_kupca = listing.get("has_bill_of_sale", True)
            if has_kupca:
                filter_chains.append(
                    f"drawbox=x=80:y=95:width=210:height=40:color=0xDC2626@0.95:t=fill,"
                    f"drawtext=fontfile='{font_bold}':text='TƏCİLİ SATIŞ':fontcolor=white:fontsize=22:x=115:y=104,"
                    f"drawbox=x=310:y=95:width=180:height=40:color=0x059669@0.95:t=fill,"
                    f"drawtext=fontfile='{font_bold}':text='KUPÇALI':fontcolor=white:fontsize=22:x=352:y=104"
                )
            else:
                filter_chains.append(
                    f"drawbox=x=80:y=95:width=210:height=40:color=0xDC2626@0.95:t=fill,"
                    f"drawtext=fontfile='{font_bold}':text='TƏCİLİ SATIŞ':fontcolor=white:fontsize=22:x=115:y=104"
                )

            # 3. Main Price Line in Gold (y=150)
            filter_chains.append(
                f"drawtext=fontfile='{font_bold}':text='{price_display}':fontcolor=0xF59E0B:fontsize=52:x=(w-text_w)/2:y=150"
            )

            # 4. Specs Line (y=230)
            filter_chains.append(
                f"drawtext=fontfile='{font_reg}':text='{specs_display}':fontcolor=0xE2E8F0:fontsize=32:x=(w-text_w)/2:y=230"
            )

            # 5. Bottom Contact / CTA Card (x=80, y=1680, w=920, h=130)
            filter_chains.append(
                f"drawbox=x=80:y=1680:width=920:height=130:color=0x0F172A@0.92:t=fill,"
                f"drawbox=x=80:y=1680:width=920:height=130:color=0x10B981@0.50:t=2,"
                f"drawtext=fontfile='{font_bold}':text='{cta_line1}':fontcolor=0xF59E0B:fontsize=26:x=(w-text_w)/2:y=1700,"
                f"drawtext=fontfile='{font_bold}':text='{cta_line2}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=1740"
            )

            # 6. Burned Subtitles via ASS filter (safe-zone MarginV=420, TikTok yellow, no black boxes)
            filter_chains.append(
                f"subtitles='{escaped_ass}'"
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
