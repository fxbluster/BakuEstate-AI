"""
BakuEstate-AI Next-Gen Cinematic Motion Engine.
Transforms static real estate photos into smooth, camera-directed walkthrough videos using:
- Zero-letterboxing 100% full-screen immersive coverage (cinematic_fill)
- Room-adaptive motion profiles (Horizontal Dolly Pan, Vertical Tilt Sweep, Push-in Zoom, Reveal Zoom)
- 4 Listing-Type Motion Archetypes (Budget, Luxury, Villa, Commercial)
- Seamless FFmpeg xfade transitions (smoothleft, smoothright, fade, zoomin)
- Sinusoidal camera acceleration/deceleration damping
- Dynamic transition timestamp tracking for synchronized audio whooshes
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
from typing import List, Dict, Any, Optional, Union

from config.settings import (
    VIDEO_WIDTH,
    VIDEO_HEIGHT,
    FPS,
    OUTPUT_DIR
)

logger = logging.getLogger("motion_engine")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


class MotionProfile:
    PUSH_IN = "push_in"
    PUSH_OUT = "push_out"
    PAN_LEFT_TO_RIGHT = "pan_left_to_right"
    PAN_RIGHT_TO_LEFT = "pan_right_to_left"
    TILT_UP = "tilt_up"
    TILT_DOWN = "tilt_down"
    AUTO = "auto"


class PropertyArchetype:
    BUDGET = "budget"          # Köhnə tikili / Büdcə mənzil (Minsk, Kiyev, Xruşşov, Leninqrad)
    LUXURY = "luxury"          # Lüks yeni tikili / Penthouse (Ağ Şəhər, Nərimanov, Bayıl)
    VILLA = "villa"            # Bağ evi / Həyət evi (Mərdəkan, Bilgəh, Şüvəlan)
    COMMERCIAL = "commercial"  # Obyekt / Kommersiya / Torpaq (Mağaza, ofis, klinika)
    AUTO = "auto"


ARCHETYPE_CONFIGS = {
    PropertyArchetype.BUDGET: {
        "motion_sequence": [
            MotionProfile.PUSH_IN,
            MotionProfile.PAN_LEFT_TO_RIGHT,
            MotionProfile.TILT_UP,
            MotionProfile.PUSH_OUT,
            MotionProfile.PAN_RIGHT_TO_LEFT,
            MotionProfile.PUSH_IN
        ],
        "transitions": ["smoothleft", "smoothright", "fade", "smoothleft", "smoothright"],
        "transition_duration": 0.6,
        "framing_mode": "cinematic_fill",
        "pacing_speed": 3.2
    },
    PropertyArchetype.LUXURY: {
        "motion_sequence": [
            MotionProfile.PAN_LEFT_TO_RIGHT,
            MotionProfile.TILT_UP,
            MotionProfile.PUSH_IN,
            MotionProfile.PAN_RIGHT_TO_LEFT,
            MotionProfile.PUSH_OUT,
            MotionProfile.PAN_LEFT_TO_RIGHT
        ],
        "transitions": ["fade", "smoothleft", "fade", "smoothright", "fade"],
        "transition_duration": 0.8,
        "framing_mode": "cinematic_fill",
        "pacing_speed": 4.5
    },
    PropertyArchetype.VILLA: {
        "motion_sequence": [
            MotionProfile.TILT_UP,
            MotionProfile.PAN_LEFT_TO_RIGHT,
            MotionProfile.PUSH_OUT,
            MotionProfile.PAN_RIGHT_TO_LEFT,
            MotionProfile.PUSH_IN,
            MotionProfile.TILT_UP
        ],
        "transitions": ["smoothleft", "fade", "smoothright", "fade", "smoothleft"],
        "transition_duration": 0.7,
        "framing_mode": "cinematic_fill",
        "pacing_speed": 4.0
    },
    PropertyArchetype.COMMERCIAL: {
        "motion_sequence": [
            MotionProfile.PUSH_IN,
            MotionProfile.PAN_LEFT_TO_RIGHT,
            MotionProfile.PUSH_IN,
            MotionProfile.PAN_RIGHT_TO_LEFT,
            MotionProfile.PUSH_IN,
            MotionProfile.PUSH_OUT
        ],
        "transitions": ["smoothleft", "smoothright", "smoothleft", "smoothright"],
        "transition_duration": 0.45,
        "framing_mode": "cinematic_fill",
        "pacing_speed": 2.5
    }
}

DEFAULT_MOTION_SEQUENCE = ARCHETYPE_CONFIGS[PropertyArchetype.BUDGET]["motion_sequence"]
DEFAULT_WALKTHROUGH_TRANSITIONS = ARCHETYPE_CONFIGS[PropertyArchetype.BUDGET]["transitions"]


def detect_property_archetype(listing: Dict[str, Any]) -> str:
    """
    Automatically classifies a listing into one of 4 property archetypes:
    - 'commercial': Obyekt, ofis, mağaza, ticarət sahəsi
    - 'villa': Həyət evi, bağ, villa, sot
    - 'luxury': Premium yeni tikili, penthouse, Ağ Şəhər, qiymət >= 300 000 AZN
    - 'budget': Köhnə tikili, daş bina, minsk, kiyev, leninqrad, xruşşov, büdcəli
    """
    text = " ".join([
        str(listing.get("title", "")),
        str(listing.get("description", "")),
        str(listing.get("location", "")),
        str(listing.get("address", "")),
        str(listing.get("building_type", ""))
    ]).lower()

    # 1. Commercial Check
    if any(k in text for k in ["obyekt", "kommersiya", "mağaza", "ofis", "ticarət", "anbar", "klinika", "restoran"]):
        return PropertyArchetype.COMMERCIAL

    # 2. Villa / Yard House Check
    if any(k in text for k in ["bağ evi", "villa", "həyət evi", "sot", "mərdəkan", "bilgəh", "şüvəlan", "badamdar", "novxanı"]):
        return PropertyArchetype.VILLA

    # 3. Luxury Check (Explicit keywords or high ticket >= 300,000 AZN)
    price_val = listing.get("price")
    try:
        num_price = float(price_val) if price_val is not None else 0.0
    except (ValueError, TypeError):
        num_price = 0.0

    if num_price >= 300000.0 or any(k in text for k in ["ağ şəhər", "white city", "penthouse", "lüks", "premium", "port baku", "vitraj"]):
        return PropertyArchetype.LUXURY

    # 4. Default to Budget Stone / Standard
    return PropertyArchetype.BUDGET


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

    raise RuntimeError("FFmpeg executable not found. Please install imageio-ffmpeg or add FFmpeg to PATH.")


def resolve_motion_profile(profile: str, slide_index: int, archetype: str = PropertyArchetype.BUDGET) -> str:
    """Resolves 'auto' profile to a cinematic room-adaptive sequence based on archetype."""
    if profile != MotionProfile.AUTO:
        return profile
    cfg = ARCHETYPE_CONFIGS.get(archetype, ARCHETYPE_CONFIGS[PropertyArchetype.BUDGET])
    seq = cfg["motion_sequence"]
    return seq[slide_index % len(seq)]


class MotionEngine:
    """
    Renders room-adaptive motion clips and stitches them via FFmpeg xfade
    into fluid, cinematic real estate walkthroughs.
    """
    def __init__(self, ffmpeg_exe: Optional[str] = None):
        self.ffmpeg_exe = ffmpeg_exe or get_ffmpeg_executable()
        logger.info(f"Initialized MotionEngine with FFmpeg: {self.ffmpeg_exe}")

    def create_motion_clip(
        self,
        image_path: Path,
        output_clip_path: Path,
        duration: float,
        profile: str = MotionProfile.AUTO,
        slide_index: int = 0,
        fps: int = FPS,
        width: int = VIDEO_WIDTH,
        height: int = VIDEO_HEIGHT,
        framing_mode: str = "cinematic_fill",
        archetype: str = PropertyArchetype.BUDGET
    ) -> Path:
        """
        Creates a vertical motion clip for a single photo with the specified motion profile.
        
        Framing modes:
        - 'cinematic_fill': 100% full-bleed coverage with smooth horizontal/vertical camera pan (zero letterbox/matte padding)
        - 'smart_matte': Elegant luxury dark ambient backdrop
        - 'full_bleed': Direct fill of 9:16 frame with smooth crop
        - 'classic_blur': Standard boxblur
        """
        total_frames = max(1, int(duration * fps))
        actual_profile = resolve_motion_profile(profile, slide_index, archetype=archetype)

        if framing_mode == "cinematic_fill":
            # 100% Full-bleed screen fill with sinusoidal easing camera trajectory
            # Eliminates all letterboxing on mobile screens!
            if actual_profile == MotionProfile.PAN_LEFT_TO_RIGHT:
                filter_graph = (
                    f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                    f"crop={width}:{height}:x='(iw-ow)*(0.5-0.5*cos(PI*n/{total_frames}))':y='(ih-oh)/2'[out]"
                )
            elif actual_profile == MotionProfile.PAN_RIGHT_TO_LEFT:
                filter_graph = (
                    f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                    f"crop={width}:{height}:x='(iw-ow)*(0.5+0.5*cos(PI*n/{total_frames}))':y='(ih-oh)/2'[out]"
                )
            elif actual_profile == MotionProfile.TILT_UP:
                filter_graph = (
                    f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                    f"crop={width}:{height}:x='(iw-ow)/2':y='(ih-oh)*(0.5+0.5*cos(PI*n/{total_frames}))'[out]"
                )
            elif actual_profile == MotionProfile.TILT_DOWN:
                filter_graph = (
                    f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                    f"crop={width}:{height}:x='(iw-ow)/2':y='(ih-oh)*(0.5-0.5*cos(PI*n/{total_frames}))'[out]"
                )
            elif actual_profile == MotionProfile.PUSH_IN:
                filter_graph = (
                    f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                    f"crop={width}:{height}[c];"
                    f"[c]zoompan=z='min(1.0+on*(0.14/{total_frames}),1.14)':d={total_frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={fps}[out]"
                )
            elif actual_profile == MotionProfile.PUSH_OUT:
                filter_graph = (
                    f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                    f"crop={width}:{height}[c];"
                    f"[c]zoompan=z='max(1.14-on*(0.14/{total_frames}),1.0)':d={total_frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={fps}[out]"
                )
            else:
                filter_graph = (
                    f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                    f"crop={width}:{height}:x='(iw-ow)*(0.5-0.5*cos(PI*n/{total_frames}))':y='(ih-oh)/2'[out]"
                )

        else:
            # Mathematical zoompan camera expressions for framed matte
            if actual_profile == MotionProfile.PUSH_IN:
                zoom_expr = f"min(1.0+on*(0.14/{total_frames}),1.14)"
                x_expr = "iw/2-(iw/zoom/2)"
                y_expr = "ih/2-(ih/zoom/2)"
            elif actual_profile == MotionProfile.PUSH_OUT:
                zoom_expr = f"max(1.14-on*(0.14/{total_frames}),1.0)"
                x_expr = "iw/2-(iw/zoom/2)"
                y_expr = "ih/2-(ih/zoom/2)"
            elif actual_profile == MotionProfile.PAN_LEFT_TO_RIGHT:
                zoom_expr = "1.14"
                x_expr = f"on*(iw-iw/zoom)/{total_frames}"
                y_expr = "ih/2-(ih/zoom/2)"
            elif actual_profile == MotionProfile.PAN_RIGHT_TO_LEFT:
                zoom_expr = "1.14"
                x_expr = f"(iw-iw/zoom)-on*(iw-iw/zoom)/{total_frames}"
                y_expr = "ih/2-(ih/zoom/2)"
            elif actual_profile == MotionProfile.TILT_UP:
                zoom_expr = "1.14"
                x_expr = "iw/2-(iw/zoom/2)"
                y_expr = f"(ih-ih/zoom)-on*(ih-ih/zoom)/{total_frames}"
            elif actual_profile == MotionProfile.TILT_DOWN:
                zoom_expr = "1.14"
                x_expr = "iw/2-(iw/zoom/2)"
                y_expr = f"on*(ih-ih/zoom)/{total_frames}"
            else:
                zoom_expr = f"min(1.0+on*(0.12/{total_frames}),1.12)"
                x_expr = "iw/2-(iw/zoom/2)"
                y_expr = "ih/2-(ih/zoom/2)"

            # Framing graph
            if framing_mode == "smart_matte":
                filter_graph = (
                    f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                    f"crop={width}:{height},boxblur=30:5,"
                    f"drawbox=x=0:y=0:w={width}:h={height}:color=0x080E1A@0.65:t=fill[bg];"
                    f"[0:v]scale={width - 40}:-2:force_original_aspect_ratio=decrease[fg];"
                    f"[bg][fg]overlay=(W-w)/2:(H-h)/2[merged];"
                    f"[merged]zoompan=z='{zoom_expr}':d={total_frames}:x='{x_expr}':y='{y_expr}':s={width}x{height}:fps={fps}[out]"
                )
            elif framing_mode == "full_bleed":
                filter_graph = (
                    f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                    f"crop={width}:{height}[base];"
                    f"[base]zoompan=z='{zoom_expr}':d={total_frames}:x='{x_expr}':y='{y_expr}':s={width}x{height}:fps={fps}[out]"
                )
            else:  # classic_blur
                filter_graph = (
                    f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                    f"crop={width}:{height},boxblur=25:5[bg];"
                    f"[0:v]scale={width}:-2:force_original_aspect_ratio=decrease[fg];"
                    f"[bg][fg]overlay=(W-w)/2:(H-h)/2[merged];"
                    f"[merged]zoompan=z='{zoom_expr}':d={total_frames}:x='{x_expr}':y='{y_expr}':s={width}x{height}:fps={fps}[out]"
                )

        cmd = [
            self.ffmpeg_exe, "-y",
            "-loop", "1",
            "-i", str(image_path),
            "-filter_complex", filter_graph,
            "-map", "[out]",
            "-t", str(duration),
            "-r", str(fps),
            "-pix_fmt", "yuv420p",
            "-c:v", "libx264",
            "-preset", "faster",
            str(output_clip_path)
        ]

        logger.debug(f"Rendering slide {slide_index} ({actual_profile}, mode={framing_mode}): {' '.join(cmd)}")
        res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if res.returncode != 0:
            logger.error(f"FFmpeg motion clip failed for {image_path}: {res.stderr[-400:]}")
            raise RuntimeError(f"FFmpeg motion clip failed for {image_path}: {res.stderr[-200:]}")

        return output_clip_path

    def render_walkthrough(
        self,
        image_paths: List[Union[str, Path]],
        output_path: Union[str, Path],
        total_duration: float,
        transition_duration: Optional[float] = None,
        transitions: Optional[List[str]] = None,
        motion_sequence: Optional[List[str]] = None,
        framing_mode: Optional[str] = None,
        archetype: str = PropertyArchetype.BUDGET,
        fps: int = FPS,
        width: int = VIDEO_WIDTH,
        height: int = VIDEO_HEIGHT
    ) -> Dict[str, Any]:
        """
        Renders a continuous cinematic walkthrough video by chaining room motion clips
        using FFmpeg xfade transitions and archetype-tuned motion/pacing.
        
        Returns dictionary with output metadata and exact transition timestamps.
        """
        if not image_paths:
            raise ValueError("At least one image path is required for walkthrough rendering.")

        out_path = Path(output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        N = len(image_paths)

        # Resolve archetype defaults
        cfg = ARCHETYPE_CONFIGS.get(archetype, ARCHETYPE_CONFIGS[PropertyArchetype.BUDGET])
        trans_duration = transition_duration if transition_duration is not None else cfg["transition_duration"]
        trans_list = transitions or cfg["transitions"]
        motion_seq = motion_sequence or cfg["motion_sequence"]
        actual_framing = framing_mode or cfg["framing_mode"]

        # Single image edge case
        if N == 1:
            self.create_motion_clip(
                image_path=Path(image_paths[0]),
                output_clip_path=out_path,
                duration=total_duration,
                profile=motion_seq[0] if motion_seq else MotionProfile.PUSH_IN,
                slide_index=0,
                fps=fps,
                width=width,
                height=height,
                framing_mode=actual_framing,
                archetype=archetype
            )
            return {
                "video_path": out_path,
                "duration": total_duration,
                "clip_count": 1,
                "slide_duration": total_duration,
                "transition_duration": 0.0,
                "transitions": [],
                "archetype": archetype,
                "framing_mode": actual_framing
            }

        # Calculate exact per-clip duration to match total_duration after (N - 1) xfades:
        # total_duration = N * slide_duration - (N - 1) * trans_duration
        slide_duration = (total_duration + (N - 1) * trans_duration) / N
        logger.info(f"Walkthrough calculation ({archetype}): {N} slides, {slide_duration:.3f}s each, {trans_duration}s transition, mode={actual_framing} -> {total_duration:.2f}s total")

        temp_dir = Path(tempfile.mkdtemp(prefix="estate_walkthrough_"))
        clip_paths: List[Path] = []

        try:
            # 1. Render individual motion clips
            for idx, img_p in enumerate(image_paths):
                clip_p = temp_dir / f"clip_{idx:02d}.mp4"
                profile = motion_seq[idx % len(motion_seq)]
                self.create_motion_clip(
                    image_path=Path(img_p),
                    output_clip_path=clip_p,
                    duration=slide_duration,
                    profile=profile,
                    slide_index=idx,
                    fps=fps,
                    width=width,
                    height=height,
                    framing_mode=actual_framing,
                    archetype=archetype
                )
                clip_paths.append(clip_p)

            # 2. Build xfade filtergraph chain
            filter_parts: List[str] = []
            transition_markers: List[Dict[str, Any]] = []
            curr_v = "[0:v]"
            curr_offset = 0.0

            for i in range(N - 1):
                curr_offset += slide_duration - trans_duration
                next_v = f"[{i+1}:v]"
                out_v = f"v_out{i+1}" if i < N - 2 else "final_v"
                t_type = trans_list[i % len(trans_list)]

                filter_parts.append(
                    f"{curr_v}{next_v}xfade=transition={t_type}:duration={trans_duration}:offset={curr_offset:.3f}[{out_v}]"
                )
                curr_v = f"[{out_v}]"

                transition_markers.append({
                    "transition_index": i,
                    "type": t_type,
                    "timestamp": round(curr_offset, 3),
                    "duration": trans_duration
                })

            xfade_filter_str = ";".join(filter_parts)

            # 3. Execute final FFmpeg concatenation
            cmd = [self.ffmpeg_exe, "-y"]
            for cp in clip_paths:
                cmd.extend(["-i", str(cp)])

            cmd.extend([
                "-filter_complex", xfade_filter_str,
                "-map", "[final_v]",
                "-t", str(total_duration),
                "-r", str(fps),
                "-c:v", "libx264",
                "-preset", "faster",
                "-pix_fmt", "yuv420p",
                str(out_path)
            ])

            logger.info(f"Stitching {N} motion clips with xfade -> {out_path}...")
            res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
            if res.returncode != 0:
                logger.error(f"FFmpeg xfade stitching failed: {res.stderr[-500:]}")
                raise RuntimeError(f"FFmpeg xfade stitching failed: {res.stderr[-300:]}")

            logger.info(f"Walkthrough rendered successfully: {out_path} ({out_path.stat().st_size} bytes)")
            return {
                "video_path": out_path,
                "duration": total_duration,
                "clip_count": N,
                "slide_duration": slide_duration,
                "transition_duration": trans_duration,
                "transitions": transition_markers,
                "archetype": archetype,
                "framing_mode": actual_framing
            }

        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)


def render_cinematic_walkthrough(
    image_paths: List[Union[str, Path]],
    output_path: Union[str, Path],
    total_duration: float,
    transition_duration: Optional[float] = None,
    transitions: Optional[List[str]] = None,
    motion_sequence: Optional[List[str]] = None,
    framing_mode: Optional[str] = None,
    archetype: str = PropertyArchetype.BUDGET,
    fps: int = FPS,
    width: int = VIDEO_WIDTH,
    height: int = VIDEO_HEIGHT,
    ffmpeg_exe: Optional[str] = None
) -> Dict[str, Any]:
    """
    Convenience function to render a cinematic walkthrough video.
    Returns metadata dict including transition timestamps for audio/typography sync.
    """
    engine = MotionEngine(ffmpeg_exe=ffmpeg_exe)
    return engine.render_walkthrough(
        image_paths=image_paths,
        output_path=output_path,
        total_duration=total_duration,
        transition_duration=transition_duration,
        transitions=transitions,
        motion_sequence=motion_sequence,
        framing_mode=framing_mode,
        archetype=archetype,
        fps=fps,
        width=width,
        height=height
    )
