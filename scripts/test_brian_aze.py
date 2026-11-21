import urllib.request
import urllib.error
import json
from pathlib import Path

API_KEY = "sk_38c6454138b8179c2cff321b96f1b64befb4b4403c1e4639"
VOICE_ID = "nPczCjzI2devNBz1zQrb"  # Brian

url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}/with-timestamps"

payload = {
    "text": "Metrodan çıxıb cəmi 3 dəqiqəyə evdəsiniz! Xalqlar Dostluğunda daş eksperimental binada qanuni 3 otaqlı mənzil. Qalın daş divarlar yayda təbii sərinlik, qışda ideal istilik saxlayır. Dövlət çıxarışı var!",
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
    headers={"xi-api-key": API_KEY.strip(), "Content-Type": "application/json"}
)

try:
    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode('utf-8'))
        import base64
        audio_bytes = base64.b64decode(res.get("audio_base64", ""))
        out_path = Path("data/output/brian_aze_test.mp3")
        out_path.write_bytes(audio_bytes)
        print(f"Brian Azerbaijani synthesis SUCCESS: {len(audio_bytes)} bytes -> {out_path}")
except Exception as e:
    print("Error:", e)
