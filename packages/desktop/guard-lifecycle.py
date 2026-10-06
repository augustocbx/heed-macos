#!/usr/bin/env python3
"""Acquire/release maintenance only on an independently verified local runtime."""
import argparse
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/"scripts"))
from service_config import service_config,saved_service_ports,local_service_url,ROOT
from service_runtime import process_records,control_targets,LEGACY,occupied,verified_api_identity
from lifecycle_metadata import BUSY_KEYS, IDENTITY_KEYS, read_status, request, valid_identity


def guard(action, base_url, owner, expected_root=None):
    if not owner or not owner.strip() or len(owner) > 128:
        raise ValueError("A maintenance owner token is required.")
    root = str(ROOT) if expected_root is None else expected_root
    if not os.path.isabs(root): raise ValueError('An absolute expected runtime root is required.')
    parsed = urlsplit(base_url)
    # Former API port is migration-only; it still requires exact process identity.
    if not (parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1','localhost') and parsed.port == LEGACY['api'] and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and parsed.path in ('','/')):
        base_url = local_service_url(base_url, "Lifecycle API")
    port = urlsplit(base_url).port
    records = process_records(port,timeout=2)
    if not records and not occupied(port): return
    identity = verified_api_identity(base_url, root)
    state = read_status(base_url, identity)
    if action == 'acquire' and any(state[key] for key in BUSY_KEYS):
        raise ValueError('An active meeting prevents installing or updating Heed.')
    # Recheck the independently expected PID/root immediately before mutation.
    if verified_api_identity(base_url, root) != identity:
        raise ValueError('The Heed listener changed. No control request was sent.')
    code, state = request(base_url, '/api/recording/maintenance',
                          {'acquire':action == 'acquire','owner':owner,'projection':'lifecycle'})
    if state and any(key in state for key in IDENTITY_KEYS):
        if not valid_identity(state,root,identity['pid']) or not all(type(state.get(key)) is bool for key in BUSY_KEYS) or (action == 'acquire' and any(state[key] for key in BUSY_KEYS)):
            raise ValueError('The backend returned an invalid compact maintenance acknowledgement.')
    if code != 200 or not state or state.get('maintenance') is not (action == 'acquire'):
        # No non-atomic success fallback: a backend without maintenance must be
        # upgraded through a supported path before service replacement.
        raise ValueError('An active meeting, another maintenance owner or unsupported guard prevents installing or updating Heed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['acquire','release'])
    parser.add_argument('--base-url')
    parser.add_argument('--expected-root')
    parser.add_argument('--owner', default=os.environ.get('HEED_LIFECYCLE_GUARD_TOKEN'))
    arguments = parser.parse_args()
    try:
        if arguments.expected_root is not None and arguments.base_url is None:
            raise ValueError('An expected runtime root requires an explicit loopback API target.')
        if arguments.base_url is not None:
            guard(arguments.action,arguments.base_url.rstrip('/'),arguments.owner,arguments.expected_root)
        else:
            ports=service_config(); previous=saved_service_ports()
            targets=control_targets(str(ROOT),ports,{port:process_records(port) for port in set([ports['api'],LEGACY['api'],*([] if previous is None else [previous['api']])])},previous)
            for port in targets: guard(arguments.action,f'http://127.0.0.1:{port}',arguments.owner)
            if not targets and occupied(ports['api']): raise ValueError('The configured API listener is not checkout-owned Heed. No services were changed.')
    except (ValueError, RuntimeError, OSError) as error:
        sys.exit(str(error))
