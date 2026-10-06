#!/usr/bin/python3
"""Opt-in native host registration for exactly one manually installed extension."""
import argparse
import json
import pathlib
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("browser", choices=["chrome", "edge"])
parser.add_argument("extension_id")
args = parser.parse_args()
if not re.fullmatch(r"[a-p]{32}", args.extension_id):
    parser.error("Use the 32-character extension ID shown by the browser's Extensions page.")
root = pathlib.Path.home() / "Library/Application Support" / ("Google/Chrome" if args.browser == "chrome" else "Microsoft Edge") / "NativeMessagingHosts"
root.mkdir(parents=True, exist_ok=True)
manifest = {"name": "local.heed.meet", "description": "Heed scoped Meet call detection", "path": str(pathlib.Path(__file__).resolve().with_name("native-host.py")), "type": "stdio", "allowed_origins": [f"chrome-extension://{args.extension_id}/"]}
path = root / "local.heed.meet.json"
path.write_text(json.dumps(manifest, indent=2) + "\n")
path.chmod(0o600)
print(f"Registered the Meet native host for {args.browser}. Restart the extension and open Heed Settings to enable Meet detection.")
