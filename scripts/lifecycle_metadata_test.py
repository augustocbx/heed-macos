"""Synthetic bounded transport fixtures; no installed data or services."""
import io
import json
import time
import unittest
import lifecycle_metadata as lifecycle

class ProjectionTest(unittest.TestCase):
    def project(self, body, **limits):
        return lifecycle.project(io.BytesIO(body), **limits)

    def test_opaque_private_values_are_skipped_and_split_escapes_validated(self):
        body = json.dumps({'session': {'text': 'PRIVATE\\"\n☃' * 15000}, 'recording': False, 'audioWork': True}).encode()
        class Split(io.BytesIO):
            def read(self, size): return super().read(min(size, 7))
            read1 = read
        self.assertEqual(lifecycle.project(Split(body)), {'recording': False, 'audioWork': True})

    def test_full_document_validation_rejects_lookalikes_and_invalid_json(self):
        for body in [b'{"recording":false,"recording":true}', b'{"recording":false,"record\\u0069ng":true}', b'{"recording":false}junk', b'{"recording":false', b'{"a":[1,]}', b'{"a":01}', b'{"a":1.}', b'{"a":"\\x"}', b'{"a":"\xff"}', b'{"a":"\xc0\x80"}', b'{"a":NaN}', b'[]', b'{"a":true,}']:
            with self.subTest(body=body), self.assertRaises(ValueError): self.project(body)
        self.assertEqual(self.project(b'{"session":{"recording":true}}'), {})
        for value in ['0', 'null', '"false"', '[]', '{}']:
            with self.assertRaises(ValueError): self.project(('{"recording":'+value+'}').encode())

    def test_explicit_finite_limits_refuse(self):
        for body, limits in [(b'{"a":"123456"}', {'max_bytes': 8}), (b'{"a":[[[0]]]}', {'max_depth': 2}), (b'{"abcdef":0}', {'max_key': 4}), (b'{"a":"123456"}', {'max_string': 4}), (b'{"a":0,"b":1}', {'max_keys': 1}), (b'{"a":[0,1,2]}', {'max_tokens': 3}), (b'{}', {'deadline': time.monotonic()-1})]:
            with self.subTest(limits=limits), self.assertRaises(ValueError): self.project(body, **limits)


# Real loopback listener with the exact supported Bun API entrypoint. This tests
# ownership, HTTP negotiation and guard effects together, without mock authority.
import os
import pathlib
import select
import subprocess
import sys
import tempfile
import service_runtime

ROOT = pathlib.Path(__file__).resolve().parents[1]

class HTTPTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='heed-lifecycle-synthetic-')
        self.root = pathlib.Path(self.temporary.name).resolve()
        (self.root/'packages/server').mkdir(parents=True)
        from unittest.mock import patch
        self.environment=patch.dict(os.environ,{'HEED_APP_DIR':str(self.root/'app'),'HEED_SERVICE_CONFIG_ROOT':str(ROOT)})
        self.environment.start()
        self.child=None; self.port=None
        self.addCleanup(self.cleanup_fixture)
        self.routes = self.root/'routes.json'
        self.log = self.root/'requests.json'
        self.routes.write_text('{}'); self.log.write_text('[]')
        (self.root/'packages/server/server.ts').write_text('''
import {readFileSync,writeFileSync} from 'node:fs';
const root=process.cwd();
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
 const path=new URL(req.url).pathname;
 const calls=JSON.parse(readFileSync('requests.json','utf8'));calls.push({path,method:req.method,body:req.method==='POST'?await req.json():null});writeFileSync('requests.json',JSON.stringify(calls));
 const routes=JSON.parse(readFileSync('routes.json','utf8'));
 if(path==='/.well-known/heed-service')return Response.json(routes.identity||{service:'heed-api',protocolVersion:1,checkoutRoot:root,pid:process.pid});
 const route=routes[path];if(!route)return new Response(null,{status:405});
 if(route.delay)await Bun.sleep(route.delay);
 const raw=route.raw??JSON.stringify(route.body);
 const data=route.chunk?new ReadableStream({start(controller){const bytes=new TextEncoder().encode(raw);for(let i=0;i<bytes.length;i+=route.chunk)controller.enqueue(bytes.subarray(i,i+route.chunk));controller.close();}}):raw;
 return new Response(data,{status:route.status??200,headers:route.headers});
}});
console.log(JSON.stringify({pid:process.pid,port:server.port}));
''')
        self.child = subprocess.Popen(['/Users/augustocbx/.bun/bin/bun','run','packages/server/server.ts'],cwd=self.root,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        self.assertTrue(select.select([self.child.stdout],[],[],5)[0], 'Fixture did not acknowledge startup')
        receipt=json.loads(self.child.stdout.readline());self.port=receipt['port'];self.assertEqual(receipt['pid'],self.child.pid)
        self.base=f'http://127.0.0.1:{self.port}'
        self.identity={'service':'heed-api','protocolVersion':1,'checkoutRoot':str(self.root),'pid':self.child.pid}
        self.idle={key:False for key in lifecycle.BUSY_KEYS}
        self.private='SYNTHETIC_PRIVATE_SENTINEL' * 4000

    def cleanup_fixture(self):
        try:
            if self.child is not None:
                if self.child.poll() is None: self.child.terminate()
                self.child.wait(timeout=5)
                self.child.stdout.close();self.child.stderr.close()
            if self.port is not None: self.assertFalse(service_runtime.occupied(self.port),'Fixture listener survived cleanup')
        finally:
            self.environment.stop()
            self.temporary.cleanup()

    def configure(self, **changes):
        routes={'/api/desktop/control/status':{'body':{'session':{'transcript':self.private},'snapshot':{'private':self.private},**self.idle}},'/api/recording/maintenance':{'body':{'session':{'transcript':self.private},'maintenance':True}}}
        routes.update(changes);self.routes.write_text(json.dumps(routes));self.log.write_text('[]')

    def guard(self, action='acquire', root=None, **env):
        return subprocess.run([sys.executable,str(ROOT/'packages/desktop/guard-lifecycle.py'),action,'--base-url',self.base,'--expected-root',str(root or self.root),'--owner','synthetic-owner'],env={**os.environ,**env},capture_output=True,text=True,timeout=10)

    def test_legacy_large_status_and_guard_acknowledgement_keep_private_values_opaque(self):
        self.configure()
        self.assertEqual(service_runtime.status(self.port,str(self.root)), self.idle)
        result=self.guard(HEED_API_PORT='48140')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertNotIn('SYNTHETIC_PRIVATE_SENTINEL',result.stderr+result.stdout)
        calls=json.loads(self.log.read_text())
        self.assertEqual([c['body'] for c in calls if c['method']=='POST'],[{'acquire':True,'owner':'synthetic-owner','projection':'lifecycle'}])
        self.configure(**{'/api/recording/maintenance':{'body':{'session':{'transcript':self.private},'maintenance':False}}})
        self.assertEqual(self.guard('release').returncode,0)

    def test_legacy_chunked_strings_validate_split_utf8_and_escapes(self):
        body={'session':{'private':'PRIVATE\\"\n☃' * 10000},**self.idle}
        self.configure(**{'/api/desktop/control/status':{'raw':json.dumps(body,ensure_ascii=False),'chunk':7}})
        self.assertEqual(service_runtime.status(self.port,str(self.root)),self.idle)

    def test_every_active_flag_and_unknown_state_prevent_acquisition(self):
        for flag in lifecycle.BUSY_KEYS:
            self.configure(**{'/api/desktop/control/status':{'body':{'session':{'transcript':self.private},**self.idle,flag:True}}})
            result=self.guard();self.assertNotEqual(result.returncode,0)
            self.assertFalse(any(c['method']=='POST' for c in json.loads(self.log.read_text())))
        for raw in ['{"snapshot":{"recording":false}}','{"recording":false,"recording":true}',json.dumps({**self.idle,'audioWork':None}),json.dumps(self.idle)+'x']:
            self.configure(**{'/api/desktop/control/status':{'raw':raw}})
            self.assertNotEqual(self.guard().returncode,0)
            self.assertFalse(any(c['method']=='POST' for c in json.loads(self.log.read_text())))

    def test_compact_negotiation_never_downgrades_invalid_or_denied_metadata(self):
        valid={**self.identity,**self.idle,'maintenance':False}
        invalid=[{'status':403},{'status':302,'headers':{'Location':'/api/desktop/control/status'}},{'raw':'{'},{'body':{**valid,'pid':1}},{'body':{**valid,'checkoutRoot':'/wrong'}},{'body':{**valid,'protocolVersion':2}},{'body':{**valid,'maintenance':0}},{'body':{**valid,'audioWork':'false'}}]
        for route in invalid:
            self.configure(**{'/api/recording/lifecycle':route})
            result=self.guard();self.assertNotEqual(result.returncode,0)
            paths=[c['path'] for c in json.loads(self.log.read_text())]
            self.assertNotIn('/api/desktop/control/status',paths)
            self.assertNotIn('/api/recording/maintenance',paths)
        for code in [404,405]:
            self.configure(**{'/api/recording/lifecycle':{'status':code}})
            self.assertEqual(self.guard().returncode,0)
        self.configure(**{'/api/recording/lifecycle':{'body':valid}})
        self.assertEqual(service_runtime.status(self.port,str(self.root)),valid)
        self.assertNotIn('/api/desktop/control/status',[c['path'] for c in json.loads(self.log.read_text())])

    def test_identity_root_pid_protocol_and_atomic_owner_conflict_refuse(self):
        for change in [{'pid':1},{'checkoutRoot':'/wrong'},{'protocolVersion':2}]:
            self.configure(identity={**self.identity,**change})
            self.assertNotEqual(self.guard().returncode,0)
            self.assertFalse(any(c['method']=='POST' for c in json.loads(self.log.read_text())))
        self.configure()
        self.assertNotEqual(self.guard(root=self.root.parent).returncode,0)
        for code in [404,409,403,302]:
            self.configure(**{'/api/recording/maintenance':{'status':code}})
            self.assertNotEqual(self.guard().returncode,0)

    def test_compact_maintenance_acknowledgement_must_match_identity_and_idle_flags(self):
        valid={**self.identity,**self.idle,'maintenance':True}
        for body in [{**valid,'pid':1},{**valid,'checkoutRoot':'/wrong'},{**valid,'protocolVersion':2},{**valid,'audioWork':True},{key:value for key,value in valid.items() if key!='audioWork'}]:
            self.configure(**{'/api/recording/maintenance':{'body':body}})
            self.assertNotEqual(self.guard().returncode,0)

    def test_restart_never_signals_or_spawns_for_missing_or_active_audio_work(self):
        from unittest.mock import patch
        records=service_runtime.process_records(self.port)
        for body in [{key:False for key in self.idle if key!='audioWork'},{**self.idle,'audioWork':True}]:
            self.configure(**{'/api/desktop/control/status':{'body':body}})
            with patch.object(service_runtime,'saved_service_ports',return_value=None), \
                 patch.object(service_runtime,'process_records',side_effect=lambda port,**kw:records if port==self.port else []), \
                 patch.object(service_runtime.os,'kill') as signal:
                with self.assertRaises((RuntimeError,ValueError)): service_runtime.restart(str(self.root),{'api':self.port})
                signal.assert_not_called()

    def test_opaque_http_syntax_and_limits_are_checked_after_flags(self):
        valid=json.dumps(self.idle)
        for tail in [',"session":{"text":"unterminated}', ',"session":[1,]}', ',"session":{"text":"\\x"}}', ',"session":'+('['*70)+'0'+(']'*70)+'}', ',"session":{"'+'k'*5000+'":0}}', ',"session":"'+('x'*(8*1024*1024))+'"}']:
            self.configure(**{'/api/desktop/control/status':{'raw':valid[:-1]+tail}})
            with self.assertRaises(ValueError): service_runtime.status(self.port,str(self.root))

    def test_explicit_guard_target_preserves_unrelated_configured_listener(self):
        import http.server
        import threading
        requests=[]
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path);self.send_response(403);self.end_headers()
            def log_message(self,*args): pass
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            self.configure()
            env={'HEED_API_PORT':str(server.server_port),'PORT':str(server.server_port),'HEED_UI_PORT':'48141','HEED_TRANSCRIPTION_PORT':'48142'}
            result=self.guard(**env);self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(requests,[])
            self.configure()
            result=self.guard(HEED_API_PORT=str(self.port),PORT=str(self.port))
            self.assertEqual(result.returncode,0,result.stderr)
            self.configure()
            result=subprocess.run([sys.executable,str(ROOT/'packages/desktop/guard-lifecycle.py'),'acquire','--owner','synthetic-owner'],env={**os.environ,**env},capture_output=True,text=True,timeout=10)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(requests,[])
            self.assertEqual(json.loads(self.log.read_text()),[])
            self.assertTrue(service_runtime.occupied(server.server_port))
        finally:
            server.shutdown();server.server_close();thread.join(timeout=3)
            self.assertFalse(thread.is_alive())
            self.assertFalse(service_runtime.occupied(server.server_port))

    def test_new_installer_guard_uses_previous_port_root_and_failure_cleanup_releases(self):
        script=(ROOT/'scripts/release/install.sh').read_text()
        selection=script[script.index('# The guard imports'):script.index('export HEED_LIFECYCLE_GUARD_TOKEN=')]
        env={**os.environ,'HEED_STAGE':str(ROOT),'HEED_PREVIOUS_DIR':str(self.root),'HEED_LEGACY_ROOT':'',
             'HEED_API_PORT':'48140','HEED_PREVIOUS_PORTS':f'{self.port} 48141 48142','HEED_LIFECYCLE_GUARD_TOKEN':'synthetic-owner'}
        self.configure()
        acquired=subprocess.run(['bash','-eu','-c',selection+'\n'+
            '"'+sys.executable+'" "$HEED_GUARD_SCRIPT" acquire --expected-root "$HEED_GUARD_ROOT" --base-url "$HEED_GUARD_URL"'],env=env,capture_output=True,text=True,timeout=10)
        self.assertEqual(acquired.returncode,0,acquired.stderr)
        self.assertTrue(any(c['method']=='POST' for c in json.loads(self.log.read_text())))
        self.configure(**{'/api/recording/maintenance':{'body':{'maintenance':False,'session':{'private':self.private}}}})
        cleanup=script.split('cleanup() {',1)[1].split('\ntrap cleanup EXIT',1)[0]
        temporary=self.root/'cleanup-temp';temporary.mkdir()
        env.update(HEED_TEMP=str(temporary),HEED_GUARD_HELD='1',HEED_COMMITTED='0',HEED_SWITCHED='0',HEED_KEEP_STAGE='1')
        released=subprocess.run(['bash','-u','-c',selection+'\ncleanup() {'+cleanup+'\n(exit 1)\ncleanup'],env=env,capture_output=True,text=True,timeout=10)
        self.assertEqual(released.returncode,0,released.stderr)
        self.assertEqual([c['body']['acquire'] for c in json.loads(self.log.read_text()) if c['method']=='POST'],[False])
        self.assertFalse(temporary.exists())
        self.assertTrue((ROOT/'scripts/lifecycle_metadata.py').exists())

    def test_stop_preflight_refuses_active_or_unknown_api_before_any_signal(self):
        sys.path.insert(0,str(ROOT/'scripts/release'))
        import heed_release
        from types import SimpleNamespace
        from unittest.mock import patch
        args=SimpleNamespace(root=[str(self.root)],ports=[self.port],timeout=0)
        for status in [{**self.idle,'audioWork':True},{'recording':False}]:
            self.configure(**{'/api/desktop/control/status':{'body':status}})
            with patch.object(heed_release.os,'kill') as signal:
                self.assertEqual(heed_release.command_stop_services(args),2)
                signal.assert_not_called()

    def test_absolute_network_deadline_and_total_body_limit_refuse(self):
        self.configure(**{'/api/recording/lifecycle':{'delay':300,'body':{}}})
        started=time.monotonic()
        with self.assertRaises(ValueError): lifecycle.request(self.base,'/api/recording/lifecycle',timeout=.05)
        self.assertLess(time.monotonic()-started,1)
        self.configure()
        with self.assertRaises(ValueError): lifecycle.request(self.base,'/api/desktop/control/status',max_bytes=65536)

if __name__ == '__main__': unittest.main()
