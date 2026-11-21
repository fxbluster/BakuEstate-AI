import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from config.settings import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
import requests

audio_path = Path("data/output/brian_aze_test.mp3")
if audio_path.exists():
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendAudio"
    with open(audio_path, "rb") as f:
        res = requests.post(
            url,
            data={
                "chat_id": TELEGRAM_CHAT_ID,
                "caption": "🎙️ ElevenLabs Multilingual v2 - Brian (Canlı Azərbaycan Dilində Test Səsi)"
            },
            files={"audio": f}
        )
    print("Telegram audio status:", res.status_code, res.json().get("ok"))
else:
    print("Audio file not found")
