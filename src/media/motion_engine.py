"""
BakuEstate-AI Next-Gen Cinematic Motion Engine.
Transforms static real estate photos into smooth, camera-directed walkthrough videos using:
- Room-adaptive motion profiles (Horizontal Dolly Pan, Vertical Tilt Sweep, Push-in Zoom, Reveal Zoom)
- Seamless FFmpeg xfade transitions (smoothleft, smoothright, fade, zoomin)
- Luxury smart-matte framing (eliminating cheap bot boxblur stripes)
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


DEFAULT_MOTION_SEQUENCE = [
    MotionProfile.PUSH_IN,             # Slide 1 (Hero hook / Living room entrance)
    MotionProfile.PAN_LEFT_TO_RIGHT,   # Slide 2 (Salon / Wide interior sweep)
    MotionProfile.TILT_UP,             # Slide 3 (High ceilings, chandeliers, duplex facade)
    MotionProfile.PUSH_OUT,            # Slide 4 (Kitchen / Master suite reveal)
    MotionProfile.PAN_RIGHT_TO_LEFT,   # Slide 5 (Balcony / City panorama sweep)
    MotionProfile.PUSH_IN              # Slide 6+
]

DEFAULT_WALKTHROUGH_TRANSITIONS = [
    "smoothleft",   # Smooth horizontal whip-pan left (feels like walking into next room)
    "smoothright",  # Smooth horizontal whip-pan right
    "fade",         # Luxury architectural dissolve
    "smoothleft",
    "smoothright"
]


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


def resolve_motion_profile(profile: str, slide_index: int) -> str:
    """Resolves 'auto' profile to a cinematic room-adaptive sequence."""
    if profile != MotionProfile.AUTO:
        return profile
    return DEFAULT_MOTION_SEQUENCE[slide_index % len(DEFAULT_MOTION_SEQUENCE)]


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
        framing_mode: str = "smart_matte"
    ) -> Path:
        """
        Creates a vertical motion clip for a single photo with the specified motion profile.
        
        Framing modes:
        - 'smart_matte': Elegant luxury dark ambient backdrop (eliminates cheap bot boxblur)
        - 'full_bleed': Direct fill of 9:16 frame with smooth crop
        - 'classic_blur': Standard boxblur
        """
        total_frames = max(1, int(duration * fps))
        actual_profile = resolve_motion_profile(profile, slide_index)

        # Mathematical zoompan camera expressions
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

        logger.debug(f"Rendering slide {slide_index} ({actual_profile}): {' '.join(cmd)}")
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
        transition_duration: float = 0.6,
        transitions: Optional[List[str]] = None,
        motion_sequence: Optional[List[str]] = None,
        framing_mode: str = "smart_matte",
        fps: int = FPS,
        width: int = VIDEO_WIDTH,
        height: int = VIDEO_HEIGHT
    ) -> Dict[str, Any]:
        """
        Renders a continuous cinematic walkthrough video by chaining room motion clips
        using FFmpeg xfade transitions.
        
        Returns dictionary with output metadata and exact transition timestamps.
        """
        if not image_paths:
            raise ValueError("At least one image path is required for walkthrough rendering.")

        out_path = Path(output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        N = len(image_paths)

        # Single image edge case
        if N == 1:
            self.create_motion_clip(
                image_path=Path(image_paths[0]),
                output_clip_path=out_path,
                duration=total_duration,
                profile=MotionProfile.PUSH_IN,
                slide_index=0,
                fps=fps,
                width=width,
                height=height,
                framing_mode=framing_mode
            )
            return {
                "video_path": out_path,
                "duration": total_duration,
                "clip_count": 1,
                "slide_duration": total_duration,
                "transition_duration": 0.0,
                "transitions": []
            }

        # Calculate exact per-clip duration to match total_duration after (N - 1) xfades:
        # total_duration = N * slide_duration - (N - 1) * transition_duration
        slide_duration = (total_duration + (N - 1) * transition_duration) / N
        logger.info(f"Walkthrough calculation: {N} slides, {slide_duration:.3f}s each, {transition_duration}s transition -> {total_duration:.2f}s total")

        temp_dir = Path(tempfile.mkdtemp(prefix="estate_walkthrough_"))
        clip_paths: List[Path] = []
        trans_list = transitions or DEFAULT_WALKTHROUGH_TRANSITIONS
        motion_seq = motion_sequence or DEFAULT_MOTION_SEQUENCE

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
                    framing_mode=framing_mode
                )
                clip_paths.append(clip_p)

            # 2. Build xfade filtergraph chain
            filter_parts: List[str] = []
            transition_markers: List[Dict[str, Any]] = []
            curr_v = "[0:v]"
            curr_offset = 0.0

            for i in range(N - 1):
                curr_offset += slide_duration - transition_duration
                next_v = f"[{i+1}:v]"
                out_v = f"v_out{i+1}" if i < N - 2 else "final_v"
                t_type = trans_list[i % len(trans_list)]

                filter_parts.append(
                    f"{curr_v}{next_v}xfade=transition={t_type}:duration={transition_duration}:offset={curr_offset:.3f}[{out_v}]"
                )
                curr_v = f"[{out_v}]"

                transition_markers.append({
                    "transition_index": i,
                    "type": t_type,
                    "timestamp": round(curr_offset, 3),
                    "duration": transition_duration
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
                "transition_duration": transition_duration,
                "transitions": transition_markers
            }

        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)


def render_cinematic_walkthrough(
    image_paths: List[Union[str, Path]],
    output_path: Union[str, Path],
    total_duration: float,
    transition_duration: float = 0.6,
    transitions: Optional[List[str]] = None,
    motion_sequence: Optional[List[str]] = None,
    framing_mode: str = "smart_matte",
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
        fps=fps,
        width=width,
        height=height
    )
