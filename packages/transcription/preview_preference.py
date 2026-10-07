"""Read the authoritative device-local setting without loading transcription engines."""
import json
import os


def saved_preview_preference():
    try:
        root = os.environ.get('HEED_APP_DIR', os.path.expanduser('~/.heed-app'))
        with open(os.path.join(root, 'config.json')) as source:
            return json.load(source).get('real_time_transcription') is not False
    except (OSError, ValueError, AttributeError):
        return True
