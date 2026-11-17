import subprocess
from pathlib import Path

video_path = Path("C:/Users/HP/BakuEstate-AI/data/output/video_5616503.mp4")
artifact_dir = Path("C:/Users/HP/.gemini/antigravity/brain/2c8a7a57-7940-40ac-95b5-940fcde3781e")

ffmpeg_exe = r"C:\Users\HP\AppData\Local\Programs\Python\Python313\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v9.0.2.exe"

timestamps = [
    (1.5, "frame_01_hero_badge.jpg"),
    (5.0, "frame_02_walkthrough_motion.jpg"),
    (15.0, "frame_03_kinetic_subtitles.jpg"),
    (27.5, "frame_04_cta_safezone.jpg")
]

for t, fname in timestamps:
    out_file = artifact_dir / fname
    cmd = [
        ffmpeg_exe, "-y",
        "-ss", str(t),
        "-i", str(video_path),
        "-vframes", "1",
        "-q:v", "2",
        str(out_file)
    ]
    subprocess.run(cmd, capture_output=True, check=True)
    print(f"Extracted frame at t={t}s -> {out_file} ({out_file.stat().st_size} bytes)")
