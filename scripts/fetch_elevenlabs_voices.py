import urllib.request
import urllib.error

API_KEY = "sk_38c6454138b8179c2cff321b96f1b64befb4b4403c1e4639"
url = "https://api.elevenlabs.io/v1/user"

req = urllib.request.Request(url, headers={"xi-api-key": API_KEY.strip()})
try:
    with urllib.request.urlopen(req) as resp:
        print("Success:", resp.read().decode('utf-8'))
except urllib.error.HTTPError as e:
    print("HTTPError:", e.code, e.reason)
    print("Body:", e.read().decode('utf-8'))
except Exception as e:
    print("Error:", e)
