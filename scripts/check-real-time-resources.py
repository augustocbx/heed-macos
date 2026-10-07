#!/usr/bin/env python3
"""Paired production-engine fixture replay, with content-free process/system measurements.

No physical capture, installed-app services, or private meeting state is used. Public model
caches are reused by the explicitly selected interpreter/native binary. No packages install.
"""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import wave

ROOT = pathlib.Path(__file__).resolve().parent.parent


def http(base, path, body=None, timeout=3600):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(base + path, data=data, headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def service(native_binary):
    sys.path.insert(0, str(ROOT / 'packages/transcription'))
    import capability
    import engines
    # Isolate preexisting modules which do not yet honor HEED_APP_DIR.
    capability.CACHE_PATH = os.path.join(os.environ['HEED_APP_DIR'], 'capabilities.json')
    if native_binary: engines._SIDECAR_BIN = str(pathlib.Path(native_binary).resolve())
    import transcription_server as server
    server.VOICES_PATH = os.path.join(os.environ['HEED_APP_DIR'], 'voices.json')
    jobs = {}
    original = server.Handler
    class MeasuredHandler(original):
        def do_GET(self):
            if self.path == '/benchmark/jobs': self._json(jobs)
            else: super().do_GET()
        def do_POST(self):
            jobs[self.path] = jobs.get(self.path, 0) + 1
            super().do_POST()
    server.Handler = MeasuredHandler
    from worker_lifecycle import worker_entrypoint
    with worker_entrypoint(): server.main()


def command_output(command):
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=5, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError): return None


def process_sample(pid):
    table = command_output(['ps','-axo','pid=,ppid=,%cpu=,rss=']) or ''
    rows = []
    for line in table.splitlines():
        fields = line.split()
        if len(fields) == 4:
            try: rows.append({'pid':int(fields[0]),'ppid':int(fields[1]),'cpuPercent':float(fields[2]),'rssKiB':int(fields[3])})
            except ValueError: pass
    owned = {pid}
    while True:
        found = owned | {row['pid'] for row in rows if row['ppid'] in owned}
        if found == owned: break
        owned = found
    processes = [row for row in rows if row['pid'] in owned]
    return {'processes':processes, 'aggregateCpuPercent':sum(row['cpuPercent'] for row in processes),
            'aggregateRssKiB':sum(row['rssKiB'] for row in processes)}


def system_sample():
    return {'vmStat':command_output(['vm_stat']), 'swap':command_output(['sysctl','vm.swapusage']),
            'memoryPressure':command_output(['memory_pressure','-Q']), 'battery':command_output(['pmset','-g','batt'])}


def file_hash(path):
    with open(path,'rb') as source:
        return hashlib.file_digest(source,'sha256').hexdigest()


def run_mode(args, fixture, enabled):
    with tempfile.TemporaryDirectory(prefix='heed-preview-measure-') as temporary:
        app = pathlib.Path(temporary)
        (app/'config.json').write_text(json.dumps({'real_time_transcription':enabled}))
        retained = app/'capture.wav';shutil.copyfile(fixture,retained)
        work = app/'work';work.mkdir()
        with socket.socket() as lease:
            lease.bind(('127.0.0.1',0));port = lease.getsockname()[1]
        env = dict(os.environ, HEED_APP_DIR=str(app), HEED_TRANSCRIPTION_PORT=str(port), HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1')
        for key in ('HEED_API_PORT','HEED_UI_PORT','PORT','HEED_SERVICE_CONFIG_ROOT'):env.pop(key,None)
        invocation = [args.python, str(pathlib.Path(__file__).resolve()), '--service']
        if args.native_binary: invocation += ['--native-binary',args.native_binary]
        # Diagnostics are not mixed with the public content-free report.
        child = subprocess.Popen(invocation, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        phase = ['startup'];samples = [];stop_sampling = threading.Event()
        def sample():
            while not stop_sampling.is_set():
                samples.append({'at':time.monotonic(),'phase':phase[0],**process_sample(child.pid)})
                stop_sampling.wait(.5)
        sampler = threading.Thread(target=sample,daemon=True);sampler.start()
        base = 'http://127.0.0.1:' + str(port)
        try:
            start = time.monotonic();health = None
            while time.monotonic()-start < args.startup_timeout:
                if child.poll() is not None:raise RuntimeError('Isolated transcription service exited before readiness')
                try:
                    health = http(base,'/health',timeout=2)
                    if health.get('load_error'):raise RuntimeError(health['load_error'])
                    if health.get('whisper') and health.get('warm'):break
                except (OSError, urllib.error.URLError):pass
                time.sleep(.2)
            else:raise TimeoutError('Isolated transcription service readiness deadline exceeded')
            engine = health.get('whisper_info',{})
            if args.native_binary and engine.get('final_model') != 'parakeet-v3':raise RuntimeError('Expected native Parakeet; actual engine differs')
            startup_seconds = time.monotonic()-start
            before = system_sample();phase[0]='capture';capture_start=time.monotonic()
            # Read and persist the identical fixture; replay live chunks at their audio cadence.
            # This tests inference/resources, not hardware capture completeness or permissions.
            with wave.open(str(retained)) as audio:
                channels,rate,width=audio.getnchannels(),audio.getframerate(),audio.getsampwidth()
                if channels not in (1,2) or width != 2 or rate != 16000:raise ValueError('Fixtures must be 16 kHz PCM16 mono/stereo WAV')
                duration=audio.getnframes()/rate
                chunk_s=float(health.get('live_tuning',{}).get('chunk_s',8))
                while True:
                    raw=audio.readframes(int(rate*chunk_s))
                    if not raw:break
                    audio_s=len(raw)/(rate*channels*width)
                    deadline=time.monotonic()+audio_s
                    if enabled:
                        # Same bounded chunks per channel as capture, using production worker HTTP.
                        for channel in range(channels):
                            chunk=work/f'preview-{channel}.wav'
                            mono=b''.join(raw[index+channel*width:index+(channel+1)*width] for index in range(0,len(raw),channels*width))
                            with wave.open(str(chunk),'wb') as output:
                                output.setparams((1,width,rate,0,'NONE','not compressed'));output.writeframes(mono)
                            http(base,'/transcribe-live',{'wav_path':str(chunk),'language':'en','audio_s':audio_s})
                            if channels == 2 and channel == 1 and engine.get('final_model') == 'parakeet-v3':
                                http(base,'/diar/live',{'wav_path':str(chunk),'window_s':audio_s})
                    time.sleep(max(0,deadline-time.monotonic()))
            capture_seconds=time.monotonic()-capture_start;after_capture=system_sample()
            phase[0]='finalization';final_start=time.monotonic()
            result=http(base,'/finalize',{'wav_path':str(retained),'work_directory':str(work),'language':'auto','allowed_languages':['en','pt'],'dual':channels==2,'mic_name':'Fixture microphone'})
            final_seconds=time.monotonic()-final_start;phase[0]='after-finalization'
            http(base,'/preview/configure',{'enabled':False},timeout=180)
            jobs=http(base,'/benchmark/jobs');after=system_sample()
            live_jobs=sum(count for path,count in jobs.items() if path in ['/transcribe-live','/diar/live','/mic/filter','/stream/start','/stream/feed'])
            if not enabled and live_jobs:raise AssertionError('Disabled run issued live inference')
            if result.get('finalized') is not True or not result.get('turns'):raise AssertionError('Final transcript has no timed speaker turns')
            return {'enabled':enabled,'engine':engine,'fixtureSha256':file_hash(fixture),
                    'retainedAudioMatches':file_hash(fixture)==file_hash(retained),'fixtureSeconds':duration,
                    'channels':channels,'startupSeconds':startup_seconds,'captureSeconds':capture_seconds,
                    'finalizationSeconds':final_seconds,'jobs':jobs,'final':{'model':result.get('model'),'language':result.get('language'),
                    'hasText':any(turn.get('text','').strip() for turn in result['turns']),
                    'speakerCount':len({turn.get('speaker') for turn in result['turns']}),'turnCount':len(result['turns']),
                    'timedTurns':all(isinstance(turn.get('start'),(int,float)) and isinstance(turn.get('end'),(int,float)) for turn in result['turns'])},
                    'samples':samples,'systemBeforeCapture':before,'systemAfterCapture':after_capture,'systemAfterFinalization':after,
                    'directEnergyMeasurement':None}
        finally:
            child.terminate()
            try:child.wait(timeout=20)
            finally:stop_sampling.set();sampler.join(6)
            if child.returncode not in (0,143,-15):raise RuntimeError(f'Owned service shutdown failed: {child.returncode}')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python',default=sys.executable,help='Existing interpreter with engine dependencies; never modified')
    parser.add_argument('--native-binary',help='Existing verified heed-parakeet binary; fails if selected engine differs')
    parser.add_argument('--fixture',action='append',default=[],help='Public/synthetic 16kHz PCM16 WAV; repeat for EN/PT')
    parser.add_argument('--output',help='Content-free JSON results')
    parser.add_argument('--order',choices=['on-off','off-on'],default='on-off')
    parser.add_argument('--startup-timeout',type=float,default=600)
    parser.add_argument('--service',action='store_true',help=argparse.SUPPRESS)
    args=parser.parse_args()
    if args.service:return service(args.native_binary)
    if not args.fixture or not args.output:parser.error('--fixture and --output are required')
    if args.native_binary and not pathlib.Path(args.native_binary).is_file():parser.error('Native binary does not exist')
    modes=[True,False] if args.order=='on-off' else [False,True]
    report={'host':{'system':platform.system(),'machine':platform.machine(),'macOS':platform.mac_ver()[0]},
            'nativeBinarySha256':file_hash(args.native_binary) if args.native_binary else None,
            'limits':['Fixture replay does not prove physical capture on either Mac.','ps %cpu is a sampled process estimate; process RSS may double-count shared pages.',
                      'OS memory pressure, swap and battery are system-wide and influenced by other apps.','Direct energy is unavailable without a separate authorized profiler.'],
            'runs':[run_mode(args,pathlib.Path(fixture).resolve(),mode) for fixture in args.fixture for mode in modes]}
    pathlib.Path(args.output).write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'runs':len(report['runs']),'output':args.output}))


if __name__ == '__main__':main()
