import urllib.request
import urllib.error
import json

API_KEY = "sk_38c6454138b8179c2cff321b96f1b64befb4b4403c1e4639"

test_voices = [
    ("Brian", "nPczCjzI2devNBz1zQrb"),
    ("Adam", "pNInz6obpgDQGcFmaJgB"),
    ("George", "JBFqnCBsd6RMkjVDRZzb"),
    ("Sarah", "EXAVITQu4vr4xnSDxMaL")
]

for name, vid in test_voices:
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{vid}"
    data = json.dumps({
        "text": "Salam",
        "model_id": "eleven_multilingual_v2"
    }).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=data,
        headers={"xi-api-key": API_KEY.strip(), "Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req) as resp:
            print(f"[{name}] SUCCESS! Bytes: {len(resp.read())}")
            break
    except urllib.error.HTTPError as e:
        print(f"[{name}] HTTPError: {e.code} - {e.read().decode('utf-8')}")
    except Exception as e:
        print(f"[{name}] Error: {e}")
