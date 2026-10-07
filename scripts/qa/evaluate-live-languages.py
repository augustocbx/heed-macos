#!/usr/bin/env python3
"""Offline production-engine replay of public EN/PT fixtures; no device capture.
Existing interpreter/native binary only. macOS outbound sandbox prevents model
network downloads. Metrics JSON is content-free; authored predictions are saved
separately for human review. Do not run benchmarks concurrently on one host.
"""
import argparse
import hashlib
import collections
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave
from live_language_metrics import score_fixture

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
# Shared content-free measurements, without modifying the paired #63 harness.
import importlib.util
_measure_spec=importlib.util.spec_from_file_location('resource_measure',ROOT/'scripts/check-real-time-resources.py')
_measure=importlib.util.module_from_spec(_measure_spec);_measure_spec.loader.exec_module(_measure)
SANDBOX='(version 1) (allow default) (deny network-outbound)'


def digest(path):
    with open(path,'rb') as source:return hashlib.file_digest(source,'sha256').hexdigest()


def process_identities():
    table=_measure.command_output(['ps','-axo','pid=,ppid=,lstart=,comm='])
    if table is None:raise RuntimeError('Owned process identity checks unavailable')
    result={}
    for line in table.splitlines():
        fields=line.split()
        if len(fields)>=8:
            try:result[int(fields[0])]={'pid':int(fields[0]),'ppid':int(fields[1]),'started':' '.join(fields[2:7]),'command':' '.join(fields[7:])}
            except ValueError:pass
    return result


def owned_identities(pid):
    table=process_identities();owned={pid}
    while True:
        found=owned | {row['pid'] for row in table.values() if row['ppid'] in owned}
        if found==owned:break
        owned=found
    return {key:table[key] for key in owned if key in table}


def surviving_owned(owned,present):
    return [pid for pid,row in owned.items() if pid in present and all(present[pid][key]==row[key] for key in ['started','command'])]


def append_diagnostics(path,content):
    # Bounded public-fixture service diagnostics; keep the tail and disclose clipping.
    existing=b''
    if path.exists():
        with path.open('rb') as source:
            source.seek(max(0,path.stat().st_size-1_048_576));existing=source.read(1_048_576)
    combined=existing+content
    clipped=max(0,len(combined)-1_048_576)
    prefix=('Earlier diagnostic bytes omitted: '+str(clipped)+'\n').encode() if clipped else b''
    path.write_bytes(prefix+combined[-1_048_576:])


def load_manifest(path):
    path=path.resolve();data=json.loads(path.read_text());root=path.parent
    if data.get('schemaVersion')!=1 or not data.get('fixtures'):raise ValueError('Unsupported fixture manifest')
    for fixture in data['fixtures']:
        audio=(root/fixture['file']).resolve()
        if not audio.is_relative_to(root):raise ValueError('Audio must stay in the fixture directory')
        if not audio.is_file() or digest(audio)!=fixture['sha256']:raise ValueError('Fixture integrity mismatch: '+fixture['file'])
        with wave.open(str(audio)) as source:
            if source.getnchannels() not in (1,2) or source.getsampwidth()!=2 or source.getframerate()!=16000:raise ValueError('Expected mono/stereo PCM16 16kHz fixture')
            duration=source.getnframes()/16000
            if abs(duration-fixture['seconds'])>.0001 or source.getnchannels()!=fixture['channels']:raise ValueError('Fixture timing/channel metadata mismatch')
        for span in fixture['spans']:
            if span['language'] not in ('en','pt') or span['channel'] not in range(fixture['channels']) or not 0<=span['start']<span['end']<=duration:raise ValueError('Invalid annotated fixture span')
    return data


def http(base,path,body=None,timeout=180):
    request=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=timeout) as response:return json.load(response)


def percentile(values,fraction):
    return sorted(values)[max(0,math.ceil(len(values)*fraction)-1)] if values else None


def verify_live(result,options):
    expected={'engine':options['engine'],'model':options['initialModel'],'modelIdentity':options['initialModelIdentity'],'language':options['effectiveLanguage'],'task':'transcribe'}
    if any(result.get(key)!=value for key,value in expected.items()):raise RuntimeError('Actual preview identity differs from explicitly selected benchmark path')


def public_result(result):
    turns=result.get('turns',[])
    return {'model':result.get('model'),'language':result.get('language'),'finalized':result.get('finalized'),'speakerCount':len({turn.get('speaker') for turn in turns}),'turnCount':len(turns),'timedTurns':all(isinstance(turn.get('start'),(int,float)) and isinstance(turn.get('end'),(int,float)) for turn in turns),'transcriptionDiagnostics':result.get('transcriptionDiagnostics')}


def service(args):
    sys.path.insert(0,str(ROOT/'packages/transcription'))
    import capability
    import engines
    capability.CACHE_PATH=str(Path(os.environ['HEED_APP_DIR'])/'capabilities.json')
    engines._SIDECAR_BIN=str(Path(args.native_binary).resolve())
    # Explicit final engine also prevents an installed overrides.json affecting replay.
    if engines.select_engine_kind()!='parakeet':raise RuntimeError('The selected native final engine is unavailable; no fallback benchmark')
    from huggingface_hub import snapshot_download
    from live_language import MLX_REPOS
    repository=MLX_REPOS[args.live_model]
    snapshot=Path(snapshot_download(repository,local_files_only=True))
    weights={'repository':repository,'revision':snapshot.name,'files':{str(path.relative_to(snapshot)):digest(path) for path in snapshot.rglob('*') if path.is_file() and path.suffix in ('.npz','.safetensors','.json')}}
    if not any(name.endswith(('.npz','.safetensors')) for name in weights['files']):raise RuntimeError('Selected live weights are not cached; downloads are forbidden')
    dependencies={}
    for name in ['mlx','mlx-whisper','huggingface-hub','numpy','faster-whisper']:
        try:dependencies[name]=importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:dependencies[name]=None
    import transcription_server as server
    server.VOICES_PATH=str(Path(os.environ['HEED_APP_DIR'])/'voices.json')
    jobs={};original=server.Handler
    from worker_lifecycle import registry,worker_entrypoint
    class EvaluatedHandler(original):
        def do_GET(self):
            if self.path=='/benchmark/environment':self._json({'weights':weights,'dependencies':dependencies,'python':sys.version,'nativeBinarySha256':digest(args.native_binary)})
            elif self.path=='/benchmark/jobs':self._json(jobs)
            elif self.path=='/benchmark/owned':
                with registry._lock:pids=[worker.proc.pid for worker in registry._workers if getattr(worker,'proc',None) is not None]
                self._json({'pids':pids})
            else:super().do_GET()
        def do_POST(self):
            if self.path=='/benchmark/shutdown':
                registry.shutdown();self._json({'closed':True});return
            jobs[self.path]=jobs.get(self.path,0)+1
            super().do_POST()
    server.Handler=EvaluatedHandler
    with worker_entrypoint():server.main()


def options_for(health,language,model,enabled):
    capabilities=health['languageCapabilities'];path=capabilities['live'];identity='mlx:mlx-community/whisper-'+model+'-mlx'
    if model=='large-v3':identity='mlx:mlx-community/whisper-large-v3-mlx-4bit'
    if path['engine']!='mlx' or path['mode']!='chunk' or identity not in [path['modelIdentity'],*[item['modelIdentity'] for item in path['adaptiveModels']]] or language not in path['supportedLanguages']:raise RuntimeError('Requested registered MLX chunk language/model is unavailable')
    # Benchmark one explicitly selected identity. Capture adaptation is validated separately;
    # never combine different weights into a quality result labeled as one model.
    return {'realTimeTranscription':enabled,'requestedLanguage':language,'effectiveLanguage':language if enabled else None,'engine':'mlx' if enabled else None,'mode':'chunk' if enabled else None,'initialModel':model if enabled else None,'initialModelIdentity':identity if enabled else None,'capabilityKey':capabilities['capabilityKey'] if enabled else None,'compatibleModels':[identity] if enabled else []}


def replay(base,fixture,audio,work,options,args,phase):
    retained=work/'capture.wav';shutil.copyfile(audio,retained)
    predictions=[[] for _ in range(fixture['channels'])];latencies=[];available_latency=[];first_preview=None;started=time.monotonic()
    before=http(base,'/benchmark/jobs',timeout=2)
    with wave.open(str(retained)) as source:
        offset=0
        while True:
            raw=source.readframes(int(16000*args.chunk_seconds))
            if not raw:break
            duration=len(raw)/(32000*fixture['channels']);available=started+offset+duration
            time.sleep(max(0,available-time.monotonic()))
            if options['realTimeTranscription']:
                for channel in range(fixture['channels']):
                    mono=b''.join(raw[index+channel*2:index+(channel+1)*2] for index in range(0,len(raw),2*fixture['channels']))
                    chunk=work/('live-'+str(channel)+'.wav')
                    with wave.open(str(chunk),'wb') as output:output.setparams((1,2,16000,0,'NONE','not compressed'));output.writeframes(mono)
                    call=time.monotonic();result=http(base,'/transcribe-live',{'wav_path':str(chunk),'language':options['effectiveLanguage'],'task':'transcribe','audio_s':duration},timeout=args.inference_timeout)
                    ended=time.monotonic();verify_live(result,options);latencies.append(ended-call);available_latency.append(ended-available)
                    text=result.get('text','')
                    if text.strip() and first_preview is None:first_preview=ended-started
                    predictions[channel].append({'text':text,'start':offset,'end':offset+duration,'language':result['language'],'modelIdentity':result['modelIdentity'],'skipped':result.get('skipped')})
            offset+=duration
    capture_seconds=time.monotonic()-started;phase[0]="finalization:"+fixture["id"];final_started=time.monotonic()
    final=http(base,'/finalize',{'wav_path':str(retained),'work_directory':str(work),'language':'auto','allowed_languages':['en','pt'],'dual':fixture['channels']==2,'mic_name':'Synthetic Owner'},timeout=args.inference_timeout)
    final_seconds=time.monotonic()-final_started
    if final.get('finalized') is not True:raise RuntimeError('Final production pass did not persist a finalized transcript')
    if final.get('model')!='parakeet-v3':raise RuntimeError('Final model identity changed; no fallback benchmark')
    if digest(retained)!=fixture['sha256']:raise RuntimeError('Replay altered the authoritative audio fixture')
    after=http(base,'/benchmark/jobs',timeout=2);jobs={path:count-before.get(path,0) for path,count in after.items() if count-before.get(path,0)}
    if not options['realTimeTranscription'] and any(jobs.get(path,0) for path in ['/transcribe-live','/diar/live','/mic/filter','/stream/start','/stream/feed']):raise RuntimeError('Disabled preview issued inference')
    scores=[]
    for channel in range(fixture['channels']):
        spans=[span for span in fixture['spans'] if span['channel']==channel]
        scores.append(score_fixture(fixture['channelReferences'][str(channel)],predictions[channel],spans) if options['realTimeTranscription'] else None)
    final_turns=sorted(final.get('turns',[]),key=lambda turn:(turn.get('start',0),turn.get('channel','')))
    final_score=score_fixture(fixture['reference'],final_turns,fixture['spans'])
    report={'fixtureId':fixture['id'],'fixtureSha256':fixture['sha256'],'fixtureSeconds':fixture['seconds'],'channels':fixture['channels'],'enabled':options['realTimeTranscription'],'fixedLanguage':options['requestedLanguage'],'initialModel':options['initialModel'],'modelIdentity':options['initialModelIdentity'],'captureSeconds':capture_seconds,'finalizationSeconds':final_seconds,'firstPreviewSeconds':first_preview,'callLatencyP50Seconds':percentile(latencies,.5),'callLatencyP95Seconds':percentile(latencies,.95),'availableToResultP95Seconds':percentile(available_latency,.95),'liveCalls':len(latencies),'liveScoresByChannel':scores,'final':public_result(final),'finalScore':final_score,'jobs':jobs,'retainedAudioMatches':True,'liveTimestampPrecision':'chunk boundaries, not word alignment'}
    public={'fixtureId':fixture['id'],'fixedLanguage':options['requestedLanguage'],'enabled':options['realTimeTranscription'],'liveByChannel':predictions,'finalTurns':final_turns}
    return report,public


def run_cohort(args,manifest,language,repeat,enabled):
    with tempfile.TemporaryDirectory(prefix='heed-live-languages-') as temporary:
        app=Path(temporary);(app/'config.json').write_text(json.dumps({'real_time_transcription':False,'live_speech_language':language}))
        with socket.socket() as lease:lease.bind(('127.0.0.1',0));port=lease.getsockname()[1]
        env={**os.environ,'PATH':'/opt/homebrew/bin:/usr/local/bin:'+os.environ.get('PATH',''),'HEED_APP_DIR':str(app),'HEED_TRANSCRIPTION_PORT':str(port),'HEED_ENGINE':'parakeet','PYTHONDONTWRITEBYTECODE':'1','HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1'}
        for key in ['HEED_API_PORT','HEED_UI_PORT','PORT','HEED_SERVICE_CONFIG_ROOT','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']:env.pop(key,None)
        invocation=['/usr/bin/sandbox-exec','-p',SANDBOX,args.python,str(Path(__file__).resolve()),'--service','--native-binary',args.native_binary,'--live-model',args.live_model]
        child=subprocess.Popen(invocation,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        diagnostics=collections.deque();diagnostic_bytes=[0];omitted=[0]
        def collect_errors():
            while True:
                data=child.stderr.read(2048)
                if not data:break
                diagnostics.append(data);diagnostic_bytes[0]+=len(data)
                while diagnostic_bytes[0]>262144:
                    removed=diagnostics.popleft();diagnostic_bytes[0]-=len(removed);omitted[0]+=len(removed)
        error_reader=threading.Thread(target=collect_errors,daemon=True);error_reader.start()
        owned={}
        phase=['startup'];samples=[];stop=threading.Event()
        def sample():
            while not stop.is_set():samples.append({'at':time.monotonic(),'phase':phase[0],**_measure.process_sample(child.pid)});stop.wait(.5)
        sampler=threading.Thread(target=sample,daemon=True);sampler.start();base='http://127.0.0.1:'+str(port);began=time.monotonic()
        try:
            while time.monotonic()-began<args.startup_timeout:
                if child.poll() is not None:raise RuntimeError('Isolated offline service exited; inspect cached model/dependency availability')
                try:
                    health=http(base,'/health',timeout=2)
                    if health.get('load_error'):raise RuntimeError(str(health['load_error']))
                    if health.get('whisper') and health.get('ready'):break
                except (OSError,urllib.error.URLError):pass
                time.sleep(.2)
            else:raise TimeoutError('Isolated service startup deadline exceeded')
            startup_seconds=time.monotonic()-began
            environment=http(base,'/benchmark/environment',timeout=10);options=options_for(health,language,args.live_model,enabled)
            http(base,'/preview/configure',{'enabled':enabled,'liveOptions':options},timeout=30)
            reports=[];predictions=[];system_before=_measure.system_sample()
            for index,fixture in enumerate(manifest['fixtures']):
                work=app/fixture['id'];work.mkdir();phase[0]='capture:'+fixture['id']
                report,public=replay(base,fixture,Path(args.fixture_manifest).resolve().parent/fixture['file'],work,options,args,phase)
                report.update(repeat=repeat,firstFixtureInFreshProcess=index==0);reports.append(report);predictions.append(public)
            phase[0]='shutdown';owned=owned_identities(child.pid)
            registered=http(base,'/benchmark/owned',timeout=2)['pids']
            if any(pid not in owned for pid in registered):raise RuntimeError('Registered worker identity was not captured before shutdown')
            http(base,'/preview/configure',{'enabled':False},timeout=30)
            http(base,'/benchmark/shutdown',{},timeout=10)
            return {'repeat':repeat,'fixedLanguage':language,'enabled':enabled,'startupReadySeconds':startup_seconds,'environment':environment,'healthPathsAtStartup':health['languageCapabilities'],'systemBefore':system_before,'systemAfter':_measure.system_sample(),'samples':samples,'ownedWorkerCount':len(registered),'ownedCleanupVerified':True,'fixtures':reports},predictions
        finally:
            if not owned:owned=owned_identities(child.pid)
            child.terminate()
            termination_error=None
            try:child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                child.kill();child.wait(timeout=5);termination_error='Owned service did not complete bounded registry shutdown'
            finally:
                stop.set();sampler.join(6);error_reader.join(2)
                child.stderr.close()
                heading=('\n=== fixedLanguage='+language+' repeat='+str(repeat)+' enabled='+str(enabled)+' truncatedServiceBytes='+str(omitted[0])+' ===\n').encode()
                append_diagnostics(Path(args.diagnostics_output),heading+b''.join(diagnostics))
            deadline=time.monotonic()+3
            survivors=surviving_owned(owned,process_identities())
            while survivors and time.monotonic()<deadline:
                time.sleep(.05);survivors=surviving_owned(owned,process_identities())
            if survivors:raise RuntimeError('Owned descendants survived shutdown: '+','.join(map(str,survivors)))
            if termination_error:raise RuntimeError(termination_error)
            if child.returncode not in (0,143,-15) and sys.exc_info()[0] is None:raise RuntimeError('Owned service shutdown failed: '+str(child.returncode))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python',default=sys.executable);parser.add_argument('--native-binary',required=True)
    parser.add_argument('--live-model',default='base',choices=['tiny','base','small','medium','large-v3'])
    parser.add_argument('--fixture-manifest',default=str(Path(__file__).parent/'fixtures/live-languages/manifest.json'))
    parser.add_argument('--output');parser.add_argument('--predictions-output');parser.add_argument('--diagnostics-output');parser.add_argument('--repeats',type=int,default=3)
    parser.add_argument('--languages',nargs='+',choices=['en','pt'],default=['en','pt']);parser.add_argument('--modes',choices=['on','off','on-off'],default='on-off')
    parser.add_argument('--chunk-seconds',type=float,default=3);parser.add_argument('--startup-timeout',type=float,default=600);parser.add_argument('--inference-timeout',type=float,default=180)
    parser.add_argument('--validate-only',action='store_true');parser.add_argument('--service',action='store_true',help=argparse.SUPPRESS);args=parser.parse_args()
    if args.service:return service(args)
    manifest=load_manifest(Path(args.fixture_manifest))
    if args.validate_only:print(json.dumps({'fixtures':len(manifest['fixtures']),'integrity':'verified','benchmarkRun':False}));return
    if not args.output or args.repeats<3 or not 0<args.chunk_seconds<=30:parser.error('An output path, at least three repeats and bounded chunk size are required')
    if platform.system()!='Darwin' or not Path('/usr/bin/sandbox-exec').exists():parser.error('Actual evaluation requires macOS outbound sandbox; no unprotected model downloads')
    for selected in [args.python,args.native_binary]:
        if not Path(selected).is_file():parser.error('Explicit existing interpreter/native binary path required')
    output=Path(args.output).resolve();predictions=Path(args.predictions_output).resolve() if args.predictions_output else output.with_suffix('.predictions.json')
    diagnostics=Path(args.diagnostics_output).resolve() if args.diagnostics_output else output.with_suffix('.stderr.log');args.diagnostics_output=str(diagnostics)
    if any(path.is_relative_to(ROOT) for path in [output,predictions,diagnostics]):parser.error('Generated evidence must stay outside the repository')
    output.parent.mkdir(parents=True,exist_ok=True);predictions.parent.mkdir(parents=True,exist_ok=True);diagnostics.parent.mkdir(parents=True,exist_ok=True)
    report={'schemaVersion':1,'implementationCommit':_measure.command_output(['git','-C',str(ROOT),'rev-parse','HEAD']),'hardware':{'platform':platform.platform(),'machine':platform.machine(),'cpu':_measure.command_output(['sysctl','-n','machdep.cpu.brand_string']),'model':_measure.command_output(['sysctl','-n','hw.model']),'memoryBytes':_measure.command_output(['sysctl','-n','hw.memsize'])},'fixtureManifestSha256':digest(args.fixture_manifest),'cohort':manifest['cohort'],'humanRegionalAccentsAvailable':manifest['humanRegionalAccentsAvailable'],'limits':manifest['limitations']+['Replay is not physical capture or installed-app evidence.','Language preservation is a lexical proxy requiring manual public-prediction review.','CPU/RSS are sampled process estimates; shared pages may be counted twice. System pressure/swap includes unrelated applications.','First fixture is a fresh process with existing offline weights; production lazy warmup is included. Later fixtures share warm residency.','No mixed-language capability claim is granted automatically.'],'runs':[]}
    public=[]
    try:
        for language in args.languages:
            for repeat in range(1,args.repeats+1):
                for enabled in ([True,False] if args.modes=='on-off' else [args.modes=='on']):
                    result,words=run_cohort(args,manifest,language,repeat,enabled);report['runs'].append(result);public.append({'repeat':repeat,'fixedLanguage':language,'enabled':enabled,'fixtures':words})
                    output.write_text(json.dumps(report,indent=2)+'\n');predictions.write_text(json.dumps(public,ensure_ascii=False,indent=2)+'\n')
    except Exception as error:
        report['error']=str(error);report['diagnosticsLog']=str(diagnostics);output.write_text(json.dumps(report,indent=2)+'\n');raise
    print(json.dumps({'runs':len(report['runs']),'output':str(output),'publicPredictions':str(predictions),'diagnosticsLog':str(diagnostics)}))
if __name__=='__main__':main()
