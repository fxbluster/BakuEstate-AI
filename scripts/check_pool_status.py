import sys
import os
import sqlite3
import tempfile
import shutil
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from config.settings import PROFILES_DIR

def inspect_all():
    print("=" * 70)
    print("GOOGLE AUTH COOKIE DETEKTORU (CANLI YOXLAMA):")
    print("=" * 70)
    auth_cookie_names = {'SID', 'SSID', 'SAPISID', 'HSID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO'}
    
    for i in range(1, 7):
        p_name = f"acc_{i}"
        target_dir = PROFILES_DIR / p_name
        if not target_dir.exists():
            print(f"[{i}] {p_name:<6} -> ❌ Qovluq mövcud deyil")
            continue
            
        found_auth_cookies = []
        all_cookie_count = 0
        all_hosts = set()
        
        for cp in target_dir.rglob("Cookies"):
            if cp.is_file() and cp.stat().st_size > 0:
                try:
                    tmp = tempfile.mktemp(suffix=".sqlite")
                    shutil.copy2(cp, tmp)
                    conn = sqlite3.connect(tmp)
                    c = conn.cursor()
                    c.execute("SELECT name, host_key FROM cookies")
                    rows = c.fetchall()
                    all_cookie_count += len(rows)
                    for name, host in rows:
                        all_hosts.add(host)
                        if name in auth_cookie_names:
                            found_auth_cookies.append(f"{name} ({host})")
                    conn.close()
                    if os.path.exists(tmp):
                        os.remove(tmp)
                except Exception as e:
                    pass
                    
        if found_auth_cookies:
            print(f"[{i}] {p_name:<6} -> 🟢 DAXİL OLUNUB! Auth çərəzləri: {', '.join(found_auth_cookies[:3])}")
        elif all_cookie_count > 0:
            google_hosts = [h for h in all_hosts if 'google' in h]
            print(f"[{i}] {p_name:<6} -> ⚠️ Brauzer açılıb amma LOGIN TAMAMLANMAYIB (SID/SSID yoxdur)")
            if google_hosts:
                print(f"      Qeydə alınan hostlar: {', '.join(list(google_hosts)[:4])}")
        else:
            print(f"[{i}] {p_name:<6} -> ❌ Tamamilə boşdur (Giriş edilməyib)")
            
    print("=" * 70)
    
    # Check default Brave profile
    default_cookie = os.path.expandvars(r'%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data\Default\Network\Cookies')
    print("Əsas (Şəxsi) Brave Brauzerinin Vəziyyəti:")
    try:
        import ctypes
        from ctypes import wintypes
        # Copy file even if locked using cmd
        tmp_default = tempfile.mktemp(suffix=".sqlite")
        cmd = f'copy /Y "{default_cookie}" "{tmp_default}" >nul 2>&1'
        os.system(cmd)
        if os.path.exists(tmp_default) and os.path.getsize(tmp_default) > 0:
            conn = sqlite3.connect(tmp_default)
            c = conn.cursor()
            c.execute("SELECT name, host_key FROM cookies WHERE host_key LIKE '%google%'")
            rows = c.fetchall()
            auths = [r[0] for r in rows if r[0] in auth_cookie_names]
            print(f"  └─ Şəxsi Brave brauzerində Google çərəzləri: {len(rows)} ədəd tapıldı. Auth çərəzləri: {set(auths)}")
            conn.close()
            os.remove(tmp_default)
        else:
            print("  └─ Şəxsi Brave brauzeri açıqdır və fayl kilidlənib.")
    except Exception as e:
        print(f"  └─ Xəta: {e}")
    print("=" * 70)

if __name__ == "__main__":
    inspect_all()
