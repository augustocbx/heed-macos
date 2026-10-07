"""Thin, bounded import event adapter over the existing authoritative recording pipeline."""
import json
import os
import threading
import time
import uuid


def stream_final_import(emit, finalize, body):
    def phase(value):
        work = body.get('work_directory')
        if work and os.path.exists(os.path.join(work, 'import-cancelled.json')):
            raise RuntimeError('Import cancelled.')
        emit('phase', {'phase': value})
    try:
        result = finalize(body['wav_path'], language=body.get('language', 'auto'),
                          is_dual=False, final_model=body.get('final_model', 'parakeet-v3'),
                          manual=body.get('manual', True), work_directory=body.get('work_directory'),
                          vocabulary=body.get('vocabulary'), on_phase=phase)
        emit('result', result)
    except Exception as error:
        emit('error', {'message': str(error)[:200]})


class ImportJobs:
    """Reattach an API restart to its still-owned pipeline; never evict active operations."""
    def __init__(self):
        self.lock = threading.Lock()
        self.jobs = {}

    def stream(self, emit, finalize, body):
        identity = body.get('job_id')
        try:
            if str(uuid.UUID(identity)) != identity:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            emit('error', {'message': 'Choose a valid import job identity.'})
            return
        signature = json.dumps(body, sort_keys=True)
        with self.lock:
            job = self.jobs.get(identity)
            owner = job is None
            if job and job['signature'] != signature:
                emit('error', {'message': 'The import job configuration changed.', 'workerUnconfirmed': not job['done'].is_set()})
                return
            if owner:
                # The one mandatory audio slot is enforced even across API restarts.
                if any(not item['done'].is_set() for item in self.jobs.values()):
                    emit('error', {'message': 'Wait for the current import transcription to finish.'})
                    return
                if len(self.jobs) >= 128:
                    completed = next((key for key, value in self.jobs.items() if value['done'].is_set()), None)
                    if completed is None:
                        emit('error', {'message': 'Import processing capacity is unavailable.'})
                        return
                    del self.jobs[completed]
                job = {'signature': signature, 'done': threading.Event(), 'phase': None, 'result': None, 'error': None}
                self.jobs[identity] = job
        def publish(event, data):
            if event == 'phase':
                job['phase'] = data
            elif event == 'result':
                job['result'] = data
            elif event == 'error':
                job['error'] = data
            try:
                emit(event, data)
            except (BrokenPipeError, ConnectionError, OSError):
                # The job still owns its actual worker when its original consumer disconnects.
                pass
        if owner:
            try:
                stream_final_import(publish, finalize, body)
            finally:
                job['done'].set()
                # Failed attempts may be retried after their actual worker has ended.
                if job['error']:
                    with self.lock:
                        if self.jobs.get(identity) is job:
                            del self.jobs[identity]
            return
        deadline = time.monotonic() + 90 * 60
        previous = None
        while not job['done'].wait(.1):
            if time.monotonic() > deadline:
                emit('error', {'message': 'The import worker is still finishing. Retry later; its audio remains protected.', 'workerUnconfirmed': True})
                return
            if job['phase'] != previous:
                previous = job['phase']
                if previous:
                    emit('phase', previous)
        emit('error' if job['error'] else 'result', job['error'] or job['result'])


IMPORT_JOBS = ImportJobs()
