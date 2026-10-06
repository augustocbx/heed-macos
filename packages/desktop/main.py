#!/usr/bin/env python3
"""
heed — Desktop Panel

Opens heed in a standalone Chrome/Chromium window (no tabs, no URL bar).
Optionally sets the window to always-on-top so it floats over Zoom/Meet.

Usage:
  python3 packages/desktop/main.py          # connects to running dev server (:48101)
  python3 packages/desktop/main.py --prod   # connects to built app (:48100)

Requires: Google Chrome or Chromium installed.
"""
import subprocess
import sys
import os
import shutil
import time
import signal
import platform

from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/"scripts"))
from service_config import service_config
from service_runtime import start as start_owned_services,read_identity
PORTS=service_config()
PROD_MODE = "--prod" in sys.argv
DEV_URL = f"http://127.0.0.1:{PORTS['ui']}"
PROD_URL = f"http://127.0.0.1:{PORTS['api']}"
APP_URL = PROD_URL if PROD_MODE else DEV_URL

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
IS_MAC = platform.system() == "Darwin"
IS_LINUX = platform.system() == "Linux"

procs = []


def find_chrome():
    """Find Chrome/Chromium binary."""
    candidates = [
        "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    ]
    if IS_MAC:
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ] + candidates

    for c in candidates:
        if shutil.which(c) or os.path.exists(c):
            return c
    return None


def is_running(url, timeout=2):
    import urllib.request
    try:
        urllib.request.urlopen(url, timeout=timeout)
        return True
    except Exception:
        return False


def start_services():
    """Start Ollama + backend services if needed."""
    if not is_running("http://localhost:11434/api/tags"):
        print("[heed] Starting Ollama...")
        procs.append(subprocess.Popen(
            ["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ))
        time.sleep(2)

    start_owned_services(ROOT_DIR,PORTS,Path.home()/"Library/Logs/Heed",services=('api','transcription') if PROD_MODE else ('api','ui','transcription'))


def set_always_on_top(window_name="heed"):
    """Set the window to always-on-top (Linux only, requires wmctrl)."""
    if not IS_LINUX:
        return
    if not shutil.which("wmctrl"):
        return
    # Wait for the window to appear
    time.sleep(2)
    try:
        subprocess.run(
            ["wmctrl", "-r", window_name, "-b", "add,above"],
            capture_output=True,
        )
        print("[heed] Window set to always-on-top")
    except Exception:
        pass


def cleanup(*args):
    for p in procs:
        try:
            p.terminate()
        except Exception:
            pass
    sys.exit(0)


def main():
    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    chrome = find_chrome()
    if not chrome:
        print("[heed] Chrome or Chromium not found.")
        print("[heed] Install it: https://www.google.com/chrome/")
        print(f"[heed] Or open {APP_URL} manually in any browser.")
        sys.exit(1)

    start_services()

    # Wait for the target URL to be ready
    if not read_identity(APP_URL,"heed-api" if PROD_MODE else "heed-ui",ROOT_DIR):
        print(f"[heed] Waiting for {APP_URL}...")
        for _ in range(30):
            if read_identity(APP_URL,"heed-api" if PROD_MODE else "heed-ui",ROOT_DIR):
                break
            time.sleep(1)

    if not read_identity(APP_URL,"heed-api" if PROD_MODE else "heed-ui",ROOT_DIR):
        sys.exit("The configured interface is not a ready checkout-owned Heed service. No browser was opened.")
    print(f"[heed] Opening {APP_URL}")

    # Launch Chrome in --app mode: standalone window, no tabs, no URL bar
    chrome_proc = subprocess.Popen([
        chrome,
        f"--app={APP_URL}",
        "--window-size=420,720",
        "--new-window",
        "--disable-extensions",
        "--disable-default-apps",
    ])
    procs.append(chrome_proc)

    # Try to set always-on-top on Linux
    if IS_LINUX:
        import threading
        threading.Thread(target=set_always_on_top, daemon=True).start()

    # Wait for Chrome to close
    chrome_proc.wait()
    cleanup()


if __name__ == "__main__":
    main()
