import sqlite3
import os
import shutil
import tempfile

cookie_file = os.path.expandvars(r'%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data\Default\Network\Cookies')
temp_dir = tempfile.mkdtemp()
temp_cookie = os.path.join(temp_dir, 'Cookies')
shutil.copy2(cookie_file, temp_cookie)

conn = sqlite3.connect(temp_cookie)
c = conn.cursor()
c.execute("SELECT DISTINCT name FROM cookies WHERE host_key LIKE '%google%'")
rows = c.fetchall()
print("Google cookies count:", len(rows))
names = [r[0] for r in rows]
print("Key cookies:", [n for n in names if any(k in n for k in ['SID', 'SSID', 'APISID', 'ACCOUNT', 'OSID', 'HSID'])])
conn.close()
shutil.rmtree(temp_dir)
