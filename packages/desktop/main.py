#!/usr/bin/env python3
"""
heed — Desktop Panel

Opens heed in a standalone Chrome/Chromium window (no tabs, no URL bar).
Optionally sets the window to always-on-top so it floats over Zoom/Meet.

Usage:
  python3 packages/desktop/main.py          # connects to running dev server (:5170)
  python3 packages/desktop/main.py --prod   # connects to built app (:5001)

Requires: Google Chrome or Chromium installed.
"""
import subprocess
import sys
import os
import shutil
import time
import signal
import platform

PROD_MODE = "--prod" in sys.argv
DEV_URL = "http://localhost:5170"
PROD_URL = "http://localhost:5001"
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

    if PROD_MODE:
        if not is_running(PROD_URL):
            print("[heed] Starting server...")
            procs.append(subprocess.Popen(
                ["bun", "run", "packages/server/server.ts"],
                cwd=ROOT_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            ))
        if not is_running("http://localhost:5002/health"):
            print("[heed] Starting transcription server...")
            procs.append(subprocess.Popen(
                ["python3", "-u", "packages/transcription/transcription_server.py"],
                cwd=ROOT_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            ))
        print("[heed] Waiting for services...")
        for _ in range(30):
            if is_running(PROD_URL) and is_running("http://localhost:5002/health"):
                print("[heed] All services ready")
                break
            time.sleep(1)


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
    if not is_running(APP_URL):
        print(f"[heed] Waiting for {APP_URL}...")
        for _ in range(30):
            if is_running(APP_URL):
                break
            time.sleep(1)

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
