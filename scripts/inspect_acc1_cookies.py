import sqlite3
import shutil
import tempfile
import os
from pathlib import Path

db = Path('data/profiles/acc_1/Default/Network/Cookies')
if db.exists():
    tmp = tempfile.mktemp(suffix=".sqlite")
    shutil.copy2(db, tmp)
    conn = sqlite3.connect(tmp)
    c = conn.cursor()
    c.execute('SELECT host_key, name, path FROM cookies WHERE host_key LIKE "%google%"')
    rows = c.fetchall()
    print(f"Total google cookies in acc_1: {len(rows)}")
    for host, name, path in rows:
        print(f"{host:35} {name:25} path={path}")
    conn.close()
    os.remove(tmp)
else:
    print("acc_1 Cookies db not found")
