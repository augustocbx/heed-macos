#!/usr/bin/env python3
"""Acquire/release the backend lifecycle guard before changing installed services."""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def guard(action, base_url, owner):
    if not owner or not owner.strip() or len(owner) > 128:
        raise ValueError("A maintenance owner token is required.")
    request = urllib.request.Request(
        base_url + "/api/recording/maintenance",
        data=json.dumps({"acquire": action == "acquire", "owner": owner}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            state = json.load(response)
        if state.get("maintenance") is not (action == "acquire"):
            raise ValueError("The backend did not acknowledge the maintenance guard.")
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise ValueError("An active meeting or another maintenance owner prevents installing or updating Heed.") from error
        # Older releases have no atomic guard. Preserve their existing busy-state check.
        with urllib.request.urlopen(base_url + "/api/desktop/control/status", timeout=5) as response:
            state = json.load(response)
        if not all(isinstance(state.get(key), bool) for key in ["recording", "processing", "pending"]):
            raise ValueError("The legacy backend did not return a valid recording status.")
        if action == "acquire" and any(state.get(key) for key in ["recording", "processing", "pending", "starting"]):
            raise ValueError("Finish the active meeting before installing or updating Heed.")
    except urllib.error.URLError as error:
        # A server that is not running cannot own capture/finalization.
        if not isinstance(error.reason, ConnectionRefusedError):
            raise ValueError("Could not check the Heed lifecycle. No services were changed.") from error


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["acquire", "release"])
    parser.add_argument("--base-url", default="http://127.0.0.1:5001")
    parser.add_argument("--owner", default=os.environ.get("HEED_LIFECYCLE_GUARD_TOKEN"))
    arguments = parser.parse_args()
    try:
        guard(arguments.action, arguments.base_url.rstrip("/"), arguments.owner)
    except (ValueError, OSError, json.JSONDecodeError, urllib.error.URLError) as error:
        sys.exit(str(error))
