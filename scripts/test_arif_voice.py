import urllib.request
import urllib.error
import json
from pathlib import Path

API_KEY = "sk_38c6454138b8179c2cff321b96f1b64befb4b4403c1e4639"
VOICE_ID = "ZQJv3hwvRAIC7fvWZ1Qr"

url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}/with-timestamps"

payload = {
    "text": "Metrodan çıxıb cəmi 3 dəqiqəyə evdəsiniz! Xalqlar Dostluğunda daş eksperimental binada qanuni 3 otaqlı mənzil.",
    "model_id": "eleven_multilingual_v2",
    "voice_settings": {
        "stability": 0.45,
        "similarity_boost": 0.80,
        "style": 0.15
    }
}

data = json.dumps(payload).encode('utf-8')
req = urllib.request.Request(
    url,
    data=data,
    headers={
        "xi-api-key": API_KEY.strip(),
        "Content-Type": "application/json"
    }
)

try:
    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode('utf-8'))
        audio_b64 = res.get("audio_base64", "")
        alignment = res.get("alignment", {})
        characters = alignment.get("characters", [])
        print(f"SUCCESS! Audio base64 length: {len(audio_b64)}, Alignment chars: {len(characters)}")
        
        # Save sample to data/output/arif_sample.mp3
        import base64
        audio_bytes = base64.b64decode(audio_b64)
        out_path = Path("data/output/arif_sample.mp3")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(audio_bytes)
        print(f"Saved audio sample to {out_path} ({len(audio_bytes)} bytes)")
except urllib.error.HTTPError as e:
    print("HTTPError:", e.code, e.reason)
    print("Body:", e.read().decode('utf-8'))
except Exception as e:
    print("Error:", e)
