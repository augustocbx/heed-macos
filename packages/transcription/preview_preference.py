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



def _active_owner_snapshot(root):
    """Verify the local API identity before reading its compact capture mode (no meeting text)."""
    import pathlib
    import urllib.request
    source_root = pathlib.Path(__file__).resolve().parents[2]
    try:
        raw = os.environ.get('HEED_API_PORT')
        if raw is None:
            try:
                with open(os.path.join(root,'service-ports.json')) as source: raw=json.load(source)['api']
            except FileNotFoundError:
                raw=json.loads((source_root/'config/service-ports.json').read_text())['api']
        port=int(raw)
        if str(port)!=str(raw) or not 1<=port<=65535 or any(low<=port<=high for low,high in [(3000,3999),(5000,5999),(7000,7999),(8000,8999)]):
            return None
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):return None
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        def read(path):
            with opener.open(f'http://127.0.0.1:{port}'+path,timeout=1) as response:
                payload=response.read(65537)
                if response.status!=200 or len(payload)>65536:raise ValueError('Invalid local capture mode response')
                return json.loads(payload)
        identity=read('/.well-known/heed-service')
        if (identity.get('service')!='heed-api' or identity.get('protocolVersion')!=1
                or pathlib.Path(identity.get('checkoutRoot','')).resolve()!=source_root):return None
        return read('/api/recording/status?inference=1')
    except (OSError,ValueError,AttributeError,TypeError,KeyError):return None


def startup_preview_policy():
    """An active checkpoint needs a verified owner; stale/unavailable ownership stays lazy."""
    saved = saved_preview_preference()
    try:
        root = os.environ.get('HEED_APP_DIR', os.path.expanduser('~/.heed-app'))
        with open(os.path.join(root, 'recording-manifest.json')) as source:manifest=json.load(source)
        snapshot = manifest.get('snapshot')
        if type(manifest.get('version')) is not int or manifest['version'] != 1 or not isinstance(snapshot, dict):return saved,False
        if snapshot.get('state') not in ('starting','recording','stopping'):return saved,False
        if (not isinstance(snapshot.get('meetingId'), str) or not snapshot['meetingId']
                or type(snapshot.get('revision')) is not int or snapshot['revision'] < 0
                or not isinstance(snapshot.get('segments'), list)
                or snapshot.get('mode') not in ('both','mic','system')):return saved,False
        owner=_active_owner_snapshot(root)
        if not isinstance(owner,dict):return False,True
        if owner.get('state') in ('idle','failed','completed','finalizing'):return saved,False
        if (owner.get('meetingId')!=snapshot['meetingId'] or type(owner.get('revision')) is not int
                or owner['revision']<snapshot['revision'] or owner.get('state') not in ('starting','recording','stopping')
                or not isinstance(owner.get('realTimeTranscription'),bool)):return False,True
        return owner['realTimeTranscription'],False
    except (OSError,ValueError,AttributeError,TypeError):return saved,False


def startup_preview_preference():
    return startup_preview_policy()[0]
