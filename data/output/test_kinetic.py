import subprocess
from pathlib import Path

ffmpeg_exe = r'C:\Users\HP\AppData\Local\Programs\Python\Python313\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win64-v4.2.2.exe'
if not Path(ffmpeg_exe).exists():
    import shutil
    ffmpeg_exe = shutil.which('ffmpeg')

photo = r'C:\Users\HP\BakuEstate-AI\data\downloads\6532081\photo_01.jpg'
badge_png = r'C:\Users\HP\BakuEstate-AI\data\output\test_glass_hero.png'
out_mp4 = r'C:\Users\HP\BakuEstate-AI\data\output\test_kinetic_render.mp4'

ass_content = """[Script Info]
Title: Baku Estate Kinetic Anti-AI
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: KineticSub,Bahnschrift,52,&H00FFFFFF,&H000000FF,&H00000000,&H60000000,-1,0,0,0,100,100,1,0,1,1.8,2.5,2,80,80,560,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.30,0:00:01.80,KineticSub,,0,0,0,,{\\t(0,90,\\fscx110\\fscy110)\\t(90,180,\\fscx100\\fscy100)}{\\c&H0080C0E6&}NƏRİMANOVDA{\\c&H00FFFFFF&} MÖHTƏŞƏM TƏKLİF!
Dialogue: 0,0:00:01.80,0:00:03.40,KineticSub,,0,0,0,,{\\t(0,90,\\fscx110\\fscy110)\\t(90,180,\\fscx100\\fscy100)}125 KVADRAT • {\\c&H0099D334&}TAM KUPÇALI{\\c&H00FFFFFF&}
Dialogue: 0,0:00:03.40,0:00:05.00,KineticSub,,0,0,0,,{\\t(0,90,\\fscx110\\fscy110)\\t(90,180,\\fscx100\\fscy100)}QIYMƏT: {\\c&H0080C0E6&}245 000 AZN{\\c&H00FFFFFF&}
"""

ass_path = Path("C:/Users/HP/BakuEstate-AI/data/output/test_kinetic.ass")
ass_path.write_text(ass_content, encoding="utf-8")
escaped_ass = str(ass_path.resolve()).replace("\\", "/").replace(":", "\\:")

filter_graph = (
    "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,"
    "zoompan=z='min(1.0+on*0.0008,1.10)':d=150:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30[base];"
    "[1:v]format=rgba[badge];"
    "[base][badge]overlay=x=(W-w)/2:y='if(lt(t,0.4), 160-(0.4-t)*80, 160)':enable='between(t,0.2,3.6)':format=auto[vcard];"
    f"[vcard]subtitles='{escaped_ass}'[out]"
)

cmd = [
    ffmpeg_exe, "-y",
    "-loop", "1", "-i", photo,
    "-i", badge_png,
    "-filter_complex", filter_graph,
    "-map", "[out]",
    "-t", "5.0",
    "-r", "30",
    "-c:v", "libx264",
    "-preset", "faster",
    "-pix_fmt", "yuv420p",
    out_mp4
]
print("Running FFmpeg render...")
res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
if res.returncode == 0:
    print(f"SUCCESS: Rendered {out_mp4} ({Path(out_mp4).stat().st_size} bytes)")
else:
    print(f"FAILED: {res.stderr[-500:]}")
