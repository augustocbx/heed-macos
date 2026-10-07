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
from lifecycle_metadata import BUSY_KEYS, IDENTITY_KEYS, read_status_with_capability, request, valid_identity, TRANSACTION


def guard(action, base_url, owner, expected_root=None, transaction_id=None):
    if not owner or not owner.strip() or len(owner) > 128:
        raise ValueError("A maintenance owner token is required.")
    if transaction_id is not None and not TRANSACTION.fullmatch(transaction_id): raise ValueError('Choose a valid update transaction.')
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
    state, legacy_negotiated = read_status_with_capability(base_url, identity)
    if transaction_id is not None and state.get('maintenanceProtocol') != 2: raise ValueError('This backend does not support durable update maintenance.')
    if transaction_id is None and state.get('updateTransactionId') is not None:
        raise ValueError('A durable update transaction prevents standalone maintenance.')
    legacy_protocol_two = legacy_negotiated and state.get('maintenanceProtocol') == 2
    if action == 'acquire' and (any(state[key] for key in BUSY_KEYS) or state.get('processingKinds')):
        raise ValueError('An active meeting prevents installing or updating Heed.')
    # Recheck the independently expected PID/root immediately before mutation.
    if verified_api_identity(base_url, root) != identity:
        raise ValueError('The Heed listener changed. No control request was sent.')
    code, state = request(base_url, '/api/recording/maintenance?summary=1' if legacy_protocol_two else '/api/recording/maintenance',
                          {'acquire':action == 'acquire','owner':owner,'projection':'lifecycle',**({'transactionId':transaction_id} if transaction_id is not None else {})},
                          max_bytes=16*1024*1024 if legacy_negotiated and not legacy_protocol_two else 65536,
                          _maintenance_ack=legacy_protocol_two)
    # A compact-capable backend cannot downgrade its acknowledgement by omitting identity.
    if not legacy_negotiated or (state and any(key in state for key in IDENTITY_KEYS)):
        if not valid_identity(state,root,identity['pid']) or not all(type(state.get(key)) is bool for key in BUSY_KEYS) or (action == 'acquire' and (any(state[key] for key in BUSY_KEYS) or state.get('processingKinds'))):
            raise ValueError('The backend returned an invalid compact maintenance acknowledgement.')
    if (transaction_id is not None or legacy_protocol_two or state and state.get('maintenanceProtocol') == 2) and (not state or state.get('maintenanceProtocol') != 2 or state.get('updateTransactionId') != (transaction_id if action == 'acquire' else None)):
        raise ValueError('The backend did not acknowledge durable update maintenance.')
    if code != 200 or not state or state.get('maintenance') is not (action == 'acquire'):
        # No non-atomic success fallback: a backend without maintenance must be
        # upgraded through a supported path before service replacement.
        raise ValueError('An active meeting, another maintenance owner or unsupported guard prevents installing or updating Heed.')
    if legacy_protocol_two:
        # A summary acknowledges only mutation; strict fresh GET supplies actual busy/identity metadata.
        if verified_api_identity(base_url, root) != identity:
            raise ValueError('The Heed listener changed after maintenance.')
        current, _ = read_status_with_capability(base_url, identity)
        if verified_api_identity(base_url, root) != identity:
            raise ValueError('The Heed listener changed after maintenance.')
        if (current.get('maintenanceProtocol') != 2 or current.get('maintenance') is not (action == 'acquire')
                or current.get('updateTransactionId') != (transaction_id if action == 'acquire' else None)
                or action == 'acquire' and (any(current[key] for key in BUSY_KEYS) or current.get('processingKinds'))):
            raise ValueError('The backend did not confirm maintenance in fresh authoritative status.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['acquire','release'])
    parser.add_argument('--base-url')
    parser.add_argument('--expected-root')
    parser.add_argument('--transaction-id', default=os.environ.get('HEED_UPDATE_TRANSACTION_ID'))
    parser.add_argument('--owner', default=os.environ.get('HEED_LIFECYCLE_GUARD_TOKEN'))
    arguments = parser.parse_args()
    try:
        if arguments.expected_root is not None and arguments.base_url is None:
            raise ValueError('An expected runtime root requires an explicit loopback API target.')
        if arguments.base_url is not None:
            guard(arguments.action,arguments.base_url.rstrip('/'),arguments.owner,arguments.expected_root,arguments.transaction_id)
        else:
            ports=service_config(); previous=saved_service_ports()
            targets=control_targets(str(ROOT),ports,{port:process_records(port) for port in set([ports['api'],LEGACY['api'],*([] if previous is None else [previous['api']])])},previous)
            for port in targets: guard(arguments.action,f'http://127.0.0.1:{port}',arguments.owner,transaction_id=arguments.transaction_id)
            if not targets and occupied(ports['api']): raise ValueError('The configured API listener is not checkout-owned Heed. No services were changed.')
    except (ValueError, RuntimeError, OSError) as error:
        sys.exit(str(error))
