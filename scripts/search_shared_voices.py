import urllib.request
import urllib.parse
import json

API_KEY = "sk_38c6454138b8179c2cff321b96f1b64befb4b4403c1e4639"
query = urllib.parse.quote("Arif")
url = f"https://api.elevenlabs.io/v1/shared-voices?search={query}"

req = urllib.request.Request(url, headers={"xi-api-key": API_KEY.strip()})
try:
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        voices = data.get("voices", [])
        print(f"Found {len(voices)} voices matching 'Arif':")
        for v in voices:
            name = v.get("name")
            vid = v.get("voice_id")
            lang = v.get("language")
            desc = v.get("description")
            print(f"- Name: {name} | ID: {vid} | Lang: {lang} | Desc: {desc}")
except Exception as e:
    print("Error:", e)
