import urllib.request
import urllib.error
import json

API_KEY = "sk_38c6454138b8179c2cff321b96f1b64befb4b4403c1e4639"
url = "https://api.elevenlabs.io/v1/voices"

req = urllib.request.Request(url, headers={"xi-api-key": API_KEY.strip()})
try:
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        voices = data.get("voices", [])
        print(f"Total voices accessible: {len(voices)}")
        for v in voices:
            name = v.get("name", "")
            vid = v.get("voice_id", "")
            cat = v.get("category", "")
            print(f"- {name:25} | ID: {vid} | Category: {cat}")
except urllib.error.HTTPError as e:
    print("HTTPError:", e.code, e.reason)
    print("Body:", e.read().decode('utf-8'))
except Exception as e:
    print("Error:", e)
