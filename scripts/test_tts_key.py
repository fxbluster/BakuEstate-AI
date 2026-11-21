import urllib.request
import urllib.error
import json

API_KEY = "sk_38c6454138b8179c2cff321b96f1b64befb4b4403c1e4639"
# Default Adam voice id: 21m00Tcm4TlvDq8ikWAM
url = "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM"

data = json.dumps({
    "text": "Salam",
    "model_id": "eleven_multilingual_v2"
}).encode('utf-8')

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
        print("TTS Success, bytes:", len(resp.read()))
except urllib.error.HTTPError as e:
    print("HTTPError:", e.code, e.reason)
    print("Body:", e.read().decode('utf-8'))
except Exception as e:
    print("Error:", e)
