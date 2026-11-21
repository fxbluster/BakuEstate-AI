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
    Places subtitles in the safe zone (MarginV=580, baseline y=1340 in [1250, 1420] px)
    with high-contrast TikTok viral yellow font, black outline, and NO opaque black boxes.
    """
    ass_header = """[Script Info]
Title: Baku Estate AI Subtitles
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ModernSub,Segoe UI,54,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3.8,1.8,2,60,60,580,1

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
        duration: Optional[float] = None,
        use_cinematic_engine: bool = False
    ) -> Path:
        """
        Orchestrates full video compilation:
        If use_cinematic_engine is True, delegates to build_cinematic_video.
        Otherwise executes standard Ken Burns video composition.
        """
        if use_cinematic_engine:
            return self.build_cinematic_video(
                listing=listing,
                image_paths=image_paths,
                audio_path=audio_path,
                srt_path=srt_path,
                output_video_path=output_video_path,
                bg_music_path=bg_music_path,
                duration=duration
            )

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

            # Convert SRT to modern ASS for safe-zone burned subtitles
            ass_path = temp_dir / "subtitles_styled.ass"
            convert_srt_to_ass(Path(srt_path), ass_path)
            escaped_ass = escape_ffmpeg_path(ass_path)

            # Generate anti-theft brand logo watermark (330x74) for content portability & brand protection
            from src.media.glass_badge import create_logo_watermark
            logo_watermark_path = temp_dir / "logo_watermark.png"
            create_logo_watermark(logo_watermark_path)
            escaped_watermark = escape_ffmpeg_path(logo_watermark_path)

            # Build final filtergraph with Unified Luxury Card (no phone leakage, safe bottom)
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

            # 5. Burned Subtitles via ASS filter (safe-zone baseline y in [1250, 1420] px, TikTok yellow, no black boxes)
            filter_chains.append(
                f"subtitles='{escaped_ass}'"
            )

            final_vf = ",".join(filter_chains)
            video_filter = f"[0:v]{final_vf}[v_base];movie='{escaped_watermark}'[wm];[v_base][wm]overlay=x=714:y=86[vout]"

            # Resolve background music with fallback to assets/music/luxury_beat.mp3
            resolved_bg_music = None
            if bg_music_path:
                p = Path(bg_music_path)
                if p.is_file():
                    resolved_bg_music = str(p.resolve())
                else:
                    cand = Path(__file__).resolve().parent.parent.parent / "assets" / "music" / p.name
                    if cand.is_file():
                        resolved_bg_music = str(cand)

            if not resolved_bg_music or not Path(resolved_bg_music).is_file():
                for cand in [
                    Path(__file__).resolve().parent.parent.parent / "assets" / "music" / "luxury_beat.mp3",
                    Path("assets/music/luxury_beat.mp3").resolve(),
                ]:
                    if cand.is_file():
                        resolved_bg_music = str(cand)
                        break

            chime_sfx = Path(__file__).resolve().parent.parent.parent / "assets" / "sfx" / "chime.mp3"
            whoosh_sfx = Path(__file__).resolve().parent.parent.parent / "assets" / "sfx" / "whoosh.mp3"

            cmd = [
                self.ffmpeg_exe, "-y",
                "-i", str(concatenated_raw),
                "-i", str(audio_path)
            ]

            if resolved_bg_music and Path(resolved_bg_music).exists():
                cmd.extend(["-stream_loop", "-1", "-i", str(resolved_bg_music)])
                fade_start = max(1.0, total_duration - 1.2)
                
                # Check SFX availability
                has_chime = chime_sfx.exists()
                has_whoosh = whoosh_sfx.exists() and num_images > 1

                audio_inputs = [
                    f"[2:a]volume=0.22,lowpass=f=3800[bg_pre];"
                    f"[bg_pre][1:a]sidechaincompress=threshold=0.08:ratio=5:attack=30:release=350[ducked_bg];"
                ]
                mix_sources = ["[ducked_bg]", "[1:a]"]
                next_input_idx = 3

                if has_chime:
                    cmd.extend(["-i", str(chime_sfx)])
                    audio_inputs.append(f"[{next_input_idx}:a]adelay=500|500,volume=0.35[sfx_chime];")
                    mix_sources.append("[sfx_chime]")
                    next_input_idx += 1

                if has_whoosh:
                    cmd.extend(["-i", str(whoosh_sfx)])
                    num_transitions = num_images - 1
                    transition_delays = [int(i * slide_duration * 1000) for i in range(1, num_images)]
                    
                    if num_transitions == 1:
                        audio_inputs.append(
                            f"[{next_input_idx}:a]adelay={transition_delays[0]}|{transition_delays[0]},volume=0.32[sfx_whooshes];"
                        )
                    else:
                        whoosh_splits = "".join(f"[w{i}]" for i in range(num_transitions))
                        split_chain = f"[{next_input_idx}:a]asplit={num_transitions}{whoosh_splits};"
                        delay_chains = ";".join(
                            f"[w{i}]adelay={transition_delays[i]}|{transition_delays[i]},volume=0.32[wd{i}]"
                            for i in range(num_transitions)
                        )
                        mix_whoosh = "".join(f"[wd{i}]" for i in range(num_transitions)) + f"amix=inputs={num_transitions}:normalize=0[sfx_whooshes];"
                        audio_inputs.append(f"{split_chain}{delay_chains};{mix_whoosh}")
                    
                    mix_sources.append("[sfx_whooshes]")
                    next_input_idx += 1

                num_mix = len(mix_sources)
                mix_chain = "".join(mix_sources) + f"amix=inputs={num_mix}:normalize=0[amixed];"
                fade_chain = f"[amixed]afade=t=out:st={fade_start:.2f}:d=1.2[aout]"
                
                audio_filter = "".join(audio_inputs) + mix_chain + fade_chain

                cmd.extend([
                    "-filter_complex", f"{video_filter};{audio_filter}",
                    "-map", "[vout]",
                    "-map", "[aout]"
                ])
            else:
                cmd.extend([
                    "-filter_complex", video_filter,
                    "-map", "[vout]",
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

    def build_cinematic_video(
        self,
        listing: Dict[str, Any],
        image_paths: List[str],
        audio_path: str,
        srt_path: str,
        output_video_path: Path,
        bg_music_path: Optional[str] = None,
        duration: Optional[float] = None,
        framing_mode: str = "cinematic_fill"
    ) -> Path:
        """
        Next-generation cinematic video compositor:
        1. Uses room-adaptive camera motion (pan/tilt/zoom) + FFmpeg xfade walkthrough transitions
           in 100% full-screen cinematic_fill mode with archetype-specific pacing.
        2. Overlays a subtle bottom gradient scrim for high subtitle contrast over bright interiors.
        3. Renders archetype-styled floating glassmorphic hero badge (dissolves at 2.5s) and CTA card.
        4. Burns 2-3 word kinetic ASS subtitles with champagne gold & mint keyword highlights
           and automatic CTA safe-shift to prevent subtitle overlap.
        5. Mixes 4-tier audio: voiceover + sidechain ducked music + transition whooshes + chime.
        """
        from src.media.motion_engine import (
            MotionEngine,
            render_cinematic_walkthrough,
            detect_property_archetype,
        )
        from src.media.glass_badge import (
            create_hero_badge,
            create_cta_badge,
            create_bottom_scrim_png,
            create_logo_watermark,
        )
        from src.media.kinetic_subtitles import convert_srt_to_kinetic_ass

        if not image_paths:
            raise ValueError("At least one image path is required to compose video.")

        output_video_path.parent.mkdir(parents=True, exist_ok=True)
        temp_dir = Path(tempfile.mkdtemp(prefix="estate_cinematic_"))

        try:
            total_duration = duration
            if not total_duration or total_duration <= 0:
                total_duration = self._probe_audio_duration(Path(audio_path))
            if total_duration <= 0:
                total_duration = len(image_paths) * SLIDE_DURATION

            archetype = detect_property_archetype(listing)
            logger.info(
                f"Rendering cinematic walkthrough for listing {listing.get('bina_id', 'unknown')} "
                f"(Archetype: {archetype}, Mode: {framing_mode}, Duration: {total_duration:.2f}s, {len(image_paths)} slides)..."
            )

            # 1. Render motion walkthrough via render_cinematic_walkthrough
            walkthrough_output = temp_dir / "walkthrough_raw.mp4"
            walkthrough_res = render_cinematic_walkthrough(
                image_paths=image_paths,
                output_path=walkthrough_output,
                total_duration=total_duration,
                framing_mode=framing_mode,
                archetype=archetype,
                ffmpeg_exe=self.ffmpeg_exe
            )
            walkthrough_raw = walkthrough_res["video_path"]
            transitions = walkthrough_res.get("transitions", [])

            # 2. Generate bottom gradient scrim for crisp subtitle readability over bright rooms
            bottom_scrim_path = temp_dir / "bottom_scrim.png"
            create_bottom_scrim_png(bottom_scrim_path)

            # 3. Generate minimal editorial hero strip (t=0.2s to t=2.5s)
            hero_badge_path = temp_dir / "hero_badge.png"
            create_hero_badge(listing, hero_badge_path, width=920, height=176, archetype=archetype)

            # 4. Generate safe-zone CTA badge
            cta_badge_path = temp_dir / "cta_badge.png"
            create_cta_badge(listing, cta_badge_path)

            # 5. Generate anti-theft brand logo watermark (persistent across entire video)
            logo_watermark_path = temp_dir / "logo_watermark.png"
            create_logo_watermark(logo_watermark_path)

            # Build video filtergraph timings
            hero_end_time = min(2.5, max(0.8, total_duration - 1.5))
            cta_start_time = max(0.5, total_duration - 6.5)

            # 6. Convert subtitles to kinetic ASS with automatic CTA safe-shift (safe-zone baseline y in [1250, 1420] px)
            ass_path = temp_dir / "subtitles_kinetic.ass"
            convert_srt_to_kinetic_ass(
                Path(srt_path),
                ass_path,
                margin_v=580,
                margin_v_cta=660,
                cta_start_time=cta_start_time,
                font_size=64,
            )
            escaped_ass = escape_ffmpeg_path(ass_path)

            v_filters = [
                f"[0:v][1:v]overlay=0:0:format=auto[v_scrim]",
                f"[v_scrim][4:v]overlay=x=714:y=86:format=auto[v_brand]",
                f"[2:v]fade=in:st=0:d=0.4:alpha=1[v_hero_faded]",
                f"[v_brand][v_hero_faded]overlay=x=(W-w)/2:y=186:enable='between(t,0,{hero_end_time:.2f})':format=auto[v_hero]",
                f"[v_hero][3:v]overlay=x=(W-w)/2:y=1380:enable='gte(t,{cta_start_time:.2f})':format=auto[v_cta]",
                f"[v_cta]subtitles='{escaped_ass}'[v_out]"
            ]
            filter_complex_v = ";".join(v_filters)

            # 7. Background music and SFX configuration with fallback to luxury_beat.mp3
            resolved_bg_music = None
            if bg_music_path:
                p = Path(bg_music_path)
                if p.is_file():
                    resolved_bg_music = str(p.resolve())
                else:
                    cand = Path(__file__).resolve().parent.parent.parent / "assets" / "music" / p.name
                    if cand.is_file():
                        resolved_bg_music = str(cand)

            if not resolved_bg_music or not Path(resolved_bg_music).is_file():
                for cand in [
                    Path(__file__).resolve().parent.parent.parent / "assets" / "music" / "luxury_beat.mp3",
                    Path("assets/music/luxury_beat.mp3").resolve(),
                ]:
                    if cand.is_file():
                        resolved_bg_music = str(cand)
                        break

            chime_sfx = Path(__file__).resolve().parent.parent.parent / "assets" / "sfx" / "chime.mp3"
            whoosh_sfx = Path(__file__).resolve().parent.parent.parent / "assets" / "sfx" / "whoosh.mp3"

            cmd = [
                self.ffmpeg_exe, "-y",
                "-i", str(walkthrough_raw),
                "-i", str(bottom_scrim_path),
                "-i", str(hero_badge_path),
                "-i", str(cta_badge_path),
                "-i", str(logo_watermark_path),
                "-i", str(audio_path)
            ]

            if resolved_bg_music and Path(resolved_bg_music).exists():
                cmd.extend(["-stream_loop", "-1", "-i", str(resolved_bg_music)])
                next_in = 7
                has_chime = chime_sfx.exists()
                has_whoosh = whoosh_sfx.exists() and len(transitions) > 0

                a_chains = [
                    f"[6:a]volume=0.20,lowpass=f=3800[bg_pre]",
                    f"[bg_pre][5:a]sidechaincompress=threshold=0.08:ratio=5:attack=30:release=350[ducked_bg]"
                ]
                mix_sources = ["[ducked_bg]", "[5:a]"]

                if has_chime:
                    cmd.extend(["-i", str(chime_sfx)])
                    a_chains.append(f"[{next_in}:a]adelay=400|400,volume=0.35[sfx_chime]")
                    mix_sources.append("[sfx_chime]")
                    next_in += 1

                if has_whoosh:
                    cmd.extend(["-i", str(whoosh_sfx)])
                    n_trans = len(transitions)
                    if n_trans == 1:
                        del_ms = int(transitions[0]["timestamp"] * 1000)
                        a_chains.append(f"[{next_in}:a]adelay={del_ms}|{del_ms},volume=0.32[sfx_whoosh]")
                        mix_sources.append("[sfx_whoosh]")
                    else:
                        whoosh_splits = "".join(f"[w{i}]" for i in range(n_trans))
                        a_chains.append(f"[{next_in}:a]asplit={n_trans}{whoosh_splits}")
                        for i, trans_info in enumerate(transitions):
                            del_ms = int(trans_info["timestamp"] * 1000)
                            a_chains.append(f"[w{i}]adelay={del_ms}|{del_ms},volume=0.32[wd{i}]")
                            mix_sources.append(f"[wd{i}]")
                    next_in += 1

                fade_start = max(1.0, total_duration - 1.2)
                a_chains.append(f"{''.join(mix_sources)}amix=inputs={len(mix_sources)}:duration=first:dropout_transition=2,volume=1.0,afade=t=out:st={fade_start:.2f}:d=1.2[a_out]")

                full_filter_complex = f"{filter_complex_v};{';'.join(a_chains)}"
                cmd.extend([
                    "-filter_complex", full_filter_complex,
                    "-map", "[v_out]",
                    "-map", "[a_out]"
                ])
            else:
                cmd.extend([
                    "-filter_complex", filter_complex_v,
                    "-map", "[v_out]",
                    "-map", "5:a"
                ])

            cmd.extend([
                "-t", str(total_duration),
                "-c:v", "libx264",
                "-preset", "faster",
                "-pix_fmt", "yuv420p",
                "-b:v", "3500k",
                "-c:a", "aac",
                "-b:a", "192k",
                "-movflags", "+faststart",
                str(output_video_path)
            ])

            logger.info(f"Compiling next-gen cinematic video -> {output_video_path}...")
            res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
            if res.returncode != 0:
                logger.error(f"FFmpeg cinematic composite failed: {res.stderr[-500:]}")
                raise RuntimeError(f"FFmpeg cinematic composite failed: {res.stderr[-300:]}")

            logger.info(f"Successfully rendered next-gen cinematic video: {output_video_path} ({output_video_path.stat().st_size} bytes)")
            return output_video_path

        finally:
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
