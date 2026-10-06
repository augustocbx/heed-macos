#!/usr/bin/env python3
"""Acquire/release the backend lifecycle guard before changing installed services."""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/"scripts"))
from service_config import service_config,saved_service_ports,local_service_url,ROOT
from service_runtime import process_records,owned_process,read_identity,control_targets,LEGACY,status,occupied


def guard(action, base_url, owner, legacy_owned=False):
    if not owner or not owner.strip() or len(owner) > 128:
        raise ValueError("A maintenance owner token is required.")
    if not legacy_owned:
        base_url=local_service_url(base_url,"Lifecycle API")
        identity=read_identity(base_url,'heed-api',str(ROOT))
        if identity is None:
            from urllib.parse import urlsplit
            if occupied(urlsplit(base_url).port):raise ValueError('The configured API listener has no matching Heed identity. No control request was sent.')
            return
    else:
        # Only main's positive process-ownership match can enter legacy migration.
        state=status(LEGACY['api'])
        if not all(type(state.get(key)) is bool for key in ['recording','processing','pending','starting']):raise ValueError('The owned legacy backend did not return valid recording status.')

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
    parser.add_argument("--base-url", default=f"http://127.0.0.1:{service_config()['api']}")
    parser.add_argument("--owner", default=os.environ.get("HEED_LIFECYCLE_GUARD_TOKEN"))
    arguments = parser.parse_args()
    try:
        ports=service_config()
        previous=saved_service_ports()
        targets=control_targets(str(ROOT),ports,{port:process_records(port) for port in set([ports['api'],LEGACY['api'],*([] if previous is None else [previous['api']])])},previous)
        if arguments.base_url!=f"http://127.0.0.1:{ports['api']}":
            guard(arguments.action,arguments.base_url.rstrip('/'),arguments.owner)
        else:
            for port in targets:
                guard(arguments.action,f'http://127.0.0.1:{port}',arguments.owner,legacy_owned=port==LEGACY['api'])
            if not targets and occupied(ports['api']):raise ValueError('The configured API listener is not checkout-owned Heed. No services were changed.')
    except (ValueError, RuntimeError, OSError, json.JSONDecodeError, urllib.error.URLError) as error:
        sys.exit(str(error))
