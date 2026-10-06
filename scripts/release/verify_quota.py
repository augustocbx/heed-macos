"""Read-only check of the persisted quota and its installed API/menu consumers."""
import argparse
import json
from pathlib import Path
import sys
from urllib.request import urlopen


def verify_quota(config, expected_bytes, api_base=None):
    def check(value, boundary):
        if type(value) is not int or value != expected_bytes:
            raise ValueError(f'{boundary} storage limit does not match expected bytes.')

    check(json.loads(Path(config).read_text()).get('storage_limit_bytes'), 'Persisted')
    if api_base:
        for path, desktop in [('/api/storage', False), ('/api/desktop/control/status', True)]:
            with urlopen(f'{api_base.rstrip("/")}{path}', timeout=3) as response:
                value = json.load(response)
            check(value.get('storage', {}).get('limitBytes') if desktop else value.get('limitBytes'),
                  'Desktop status' if desktop else 'Storage API')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--expected-bytes', required=True, type=int)
    parser.add_argument('--api-base')
    arguments = parser.parse_args()
    try:
        verify_quota(arguments.config, arguments.expected_bytes, arguments.api_base)
    except (OSError, ValueError, TypeError, AttributeError) as error:
        print(f'Quota verification failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
