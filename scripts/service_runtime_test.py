import importlib.util
import pathlib
import unittest
import json
import sys
import threading
import tempfile
import subprocess
import socket
import time
import os
import signal
from unittest.mock import patch
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
SPEC=importlib.util.spec_from_file_location('service_runtime',pathlib.Path(__file__).with_name('service_runtime.py'))
module=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(module)
class Handler(BaseHTTPRequestHandler):
 payload=b'<html>another app</html>'
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(self.payload)
 def log_message(self,*args):pass
class RuntimeTests(unittest.TestCase):
 def test_explicit_lifecycle_base_uses_only_its_validated_destination(self):
  root=pathlib.Path(__file__).resolve().parents[1]
  servers=[];threads=[];requests={'default':[],'explicit':[]}
  def responder(name,checkout):
   class LifecycleHandler(BaseHTTPRequestHandler):
    def do_GET(self):
     requests[name].append(('GET',self.path))
     self.send_response(200);self.end_headers()
     self.wfile.write(json.dumps({'service':'heed-api','protocolVersion':1,'checkoutRoot':str(checkout),'pid':os.getpid()}).encode())
    def do_POST(self):
     payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
     requests[name].append(('POST',self.path,payload))
     self.send_response(200);self.end_headers()
     self.wfile.write(json.dumps({'maintenance':payload['acquire']}).encode())
    def log_message(self,*args):pass
   server=ThreadingHTTPServer(('127.0.0.1',0),LifecycleHandler)
   self.assertGreaterEqual(server.server_port,49152,'Use only allowed disposable fixture ports')
   thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
   servers.append(server);threads.append(thread);return server
  try:
   foreign=responder('default',root/'different-checkout')
   destination=responder('explicit',root)
   environment={**os.environ,'HEED_API_PORT':str(foreign.server_port),'PORT':str(foreign.server_port),'HEED_UI_PORT':'48101','HEED_TRANSCRIPTION_PORT':'48102'}
   command=[sys.executable,str(root/'packages/desktop/guard-lifecycle.py'),'acquire','--base-url',f'http://127.0.0.1:{destination.server_port}','--owner','synthetic-explicit-target']
   result=subprocess.run(command,env=environment,capture_output=True,text=True,timeout=10)
   self.assertEqual(result.returncode,0,result.stderr)
   self.assertEqual(requests['default'],[],'An explicit target must not inspect or control the configured default')
   self.assertEqual(requests['explicit'],[('GET','/.well-known/heed-service'),('POST','/api/recording/maintenance',{'acquire':True,'owner':'synthetic-explicit-target'})])
   self.assertTrue(module.occupied(foreign.server_port),'The unrelated default listener must be preserved')
   # Argument presence, rather than comparison to the configured URL, selects explicit routing.
   requests['explicit'].clear();environment.update(HEED_API_PORT=str(destination.server_port),PORT=str(destination.server_port))
   result=subprocess.run(command,env=environment,capture_output=True,text=True,timeout=10)
   self.assertEqual(result.returncode,0,result.stderr)
   self.assertEqual([entry[0] for entry in requests['explicit']],['GET','POST'])
   # Explicit routing retains the canonical checkout-identity gate before any control request.
   requests['explicit'].clear();command[4]=f'http://127.0.0.1:{foreign.server_port}'
   result=subprocess.run(command,env=environment,capture_output=True,text=True,timeout=10)
   self.assertEqual(result.returncode,1)
   self.assertIn('no matching Heed identity',result.stderr)
   self.assertEqual(requests['default'],[('GET','/.well-known/heed-service')])
   self.assertEqual(requests['explicit'],[])
   result=subprocess.run([*command[:3],*command[5:]],env=environment,capture_output=True,text=True,timeout=10)
   self.assertEqual(result.returncode,1,'Omitting --base-url must preserve default process-ownership discovery')
   self.assertIn('belongs to another application',result.stderr)
   self.assertEqual(requests['explicit'],[],'Default discovery must not control an unowned responder even with matching identity')
  finally:
   for server in servers:server.shutdown();server.server_close()
   for thread in threads:thread.join(timeout=3);self.assertFalse(thread.is_alive())
 def test_framework_python_process_uses_exact_checkout_script_and_complete_arguments(self):
  with tempfile.TemporaryDirectory(prefix='heed-framework-command-') as directory:
   root=pathlib.Path(directory)/('synthetic-checkout-'+('a'*90))
   folder=root/'packages/transcription';folder.mkdir(parents=True)
   script=folder/'transcription_server.py';script.write_text('import socket,time\ns=socket.socket();s.bind(("127.0.0.1",0));s.listen();print(s.getsockname()[1],flush=True);time.sleep(60)\n')
   child=subprocess.Popen([sys.executable,'-u',str(script)],cwd=root,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,text=True)
   try:
    port=int(child.stdout.readline());records=module.process_records(port)
    self.assertTrue(any(record['pid']==child.pid and module.owned_process(str(root),'transcription',record['cwd'],record['command']) for record in records))
   finally:child.terminate();child.wait(timeout=3);child.stdout.close()
  command='/Library/Frameworks/Python.framework/Resources/Python.app/Contents/MacOS/Python -u /qa/packages/transcription/transcription_server.py'
  self.assertTrue(module.owned_process('/qa','transcription','/qa',command))
  for wrong in ['ruby -u /qa/packages/transcription/transcription_server.py','Python -u /other/packages/transcription/transcription_server.py','Python --eval /qa/packages/transcription/transcription_server.py','Python -u /qa/packages/transcription/transcription_server.py --unknown']:
   self.assertFalse(module.owned_process('/qa','transcription','/qa',wrong))
 def setUp(self):
  self.app=tempfile.TemporaryDirectory(prefix='heed-bootstrap-status-')
  self.environment=patch.dict(os.environ,{'HEED_APP_DIR':self.app.name})
  self.environment.start()
 def tearDown(self):
  self.environment.stop();self.app.cleanup()
 def test_rejects_arbitrary_http_success_and_wrong_identity(self):
  server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  try:
   url=f'http://127.0.0.1:{server.server_port}'
   self.assertIsNone(module.read_identity(url,'heed-transcription','/qa'))
   Handler.payload=json.dumps({'ready':True,'whisper':True,'service':'another-app'}).encode()
   self.assertIsNone(module.read_identity(url,'heed-transcription','/qa'))
   Handler.payload=json.dumps({'service':'heed-transcription','protocolVersion':1,'checkoutRoot':'/different','pid':22,'ready':True,'whisper':True,'pyannote':False}).encode()
   self.assertIsNone(module.read_identity(url,'heed-transcription','/qa'))
   Handler.payload=json.dumps({'service':'heed-transcription','protocolVersion':1,'checkoutRoot':'/qa','pid':22,'ready':False,'whisper':False,'pyannote':False}).encode()
   self.assertEqual(module.read_identity(url,'heed-transcription','/qa')['pid'],22)
  finally:server.shutdown();server.server_close();thread.join()
 def test_checkout_cwd_alone_does_not_authorize_stopping_foreign_process(self):
  self.assertFalse(module.owned_process('/qa','transcription','/qa','ruby application.rb'))
  self.assertFalse(module.owned_process('/qa','transcription','/other','python /qa/packages/transcription/transcription_server.py'))
  self.assertTrue(module.owned_process('/qa','transcription','/qa','python3 -u /qa/packages/transcription/transcription_server.py'))
  self.assertFalse(module.owned_process('/qa','api','/qa','bun another.ts'))
  self.assertTrue(module.owned_process('/qa','api','/qa','bun run packages/server/server.ts'))
 def test_documented_bun_watch_hot_and_exact_server_entries_share_the_owned_authorizer(self):
  for command in ['bun --watch packages/server/server.ts','bun --hot run /qa/packages/server/server.ts','bun run --watch packages/server/server.ts','/safe/bin/bun run /qa/packages/server/server.ts']:
   self.assertTrue(module.owned_process('/qa','api','/qa',command),command)
  self.assertTrue(module.owned_process('/qa','api','/qa/packages/server','bun --hot server.ts'))
  for command in ['bun --eval packages/server/server.ts','bun run packages/server/server.ts --unknown','bun run /other/packages/server/server.ts','bun --watch other.ts','ruby packages/server/server.ts']:
   self.assertFalse(module.owned_process('/qa','api','/qa',command),command)
  self.assertFalse(module.owned_process('/qa','api','/qa/packages/client','bun run server.ts'))
  self.assertFalse(module.owned_process('/qa','api','/other','bun run /qa/packages/server/server.ts'))
 def test_restart_preflight_never_kills_partial_owned_set_when_foreign_target_conflicts(self):
  with self.assertRaisesRegex(RuntimeError,'another application'):
   module.restart_plan('/qa',{'api':48100,'ui':48101,'transcription':48102},{48100:[{'pid':20,'cwd':'/qa','command':'bun run packages/server/server.ts'}],48102:[{'pid':99,'cwd':'/other','command':'ruby other.rb'}]},lambda port:{'recording':False,'processing':False,'pending':False,'starting':False})
 def test_legacy_foreign_ports_are_preserved_but_owned_busy_api_blocks_all(self):
  foreign={5002:[{'pid':99,'cwd':'/other','command':'ruby other.rb'}]}
  self.assertEqual(module.restart_plan('/qa',{'api':48100,'ui':48101,'transcription':48102},foreign,lambda port:{}),[])
  foreign[5001]=[{'pid':20,'cwd':'/qa','command':'bun run packages/server/server.ts'}]
  with self.assertRaisesRegex(RuntimeError,'active meeting'):
   module.restart_plan('/qa',{'api':48100,'ui':48101,'transcription':48102},foreign,lambda port:{'recording':True,'processing':False,'pending':False,'starting':False})
 def test_lifecycle_targets_only_owned_api_and_ignores_foreign_legacy_listener(self):
  ports={'api':48100,'ui':48101,'transcription':48102}
  self.assertEqual(module.control_targets('/qa',ports,{5001:[{'pid':99,'cwd':'/other','command':'ruby other.rb'}]}),[])
  with self.assertRaisesRegex(RuntimeError,'another application'):
   module.control_targets('/qa',ports,{48100:[{'pid':99,'cwd':'/other','command':'ruby other.rb'}]})
  self.assertEqual(module.control_targets('/qa',ports,{5001:[{'pid':20,'cwd':'/qa','command':'bun run packages/server/server.ts'}]}),[5001])
 def test_saved_custom_ports_are_guarded_and_retired_before_installing_new_ports(self):
  ports={'api':48120,'ui':48121,'transcription':48122};previous={'api':48110,'ui':48111,'transcription':48112}
  records={48110:[{'pid':20,'cwd':'/qa','command':'bun run packages/server/server.ts'}],48112:[{'pid':21,'cwd':'/qa','command':'python3 -u packages/transcription/transcription_server.py'}]}
  self.assertEqual(module.control_targets('/qa',ports,records,previous),[48110])
  self.assertEqual(set(module.restart_plan('/qa',ports,records,lambda port:{'recording':False,'processing':False,'pending':False,'starting':False},previous)),{20,21})
 def test_failed_startup_reaps_wrapper_and_listening_grandchild(self):
  self.assert_startup_tree_rollback(wrapper_exit=False)
 def test_rollback_inspection_failure_preserves_unverified_group_but_reaps_other_owned_children(self):
  original=subprocess.Popen;children=[];signalled=[]
  def launch(command,*args,**kwargs):
   if command[0] in ('ps','pgrep'):return original(command,*args,**kwargs)
   if len(children)==2:raise OSError('injected third-service spawn failure')
   child=original([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   children.append(child);return child
  signal_group=module.signal_owned_group
  def inspect(group,kind):
   if group==children[0].pid:raise RuntimeError('injected ownership inspection failure')
   signalled.append(group);return signal_group(group,kind)
  try:
   with tempfile.TemporaryDirectory(prefix='heed-rollback-fault-') as directory,patch.object(module,'read_identity',return_value=None),patch.object(module,'process_records',return_value=[]),patch.object(module,'occupied',return_value=False),patch.object(module.subprocess,'Popen',side_effect=launch),patch.object(module,'signal_owned_group',side_effect=inspect):
    with self.assertRaises((OSError,RuntimeError)):
     module.start(directory,{'api':48100,'ui':48101,'transcription':48102},pathlib.Path(directory)/'logs')
   self.assertEqual(len(children),2)
   self.assertIsNotNone(children[1].poll(),'An inspection failure in one group must not orphan another verified owned service')
   self.assertIsNone(children[0].poll(),'An unverified group must not be signalled')
   self.assertNotIn(children[0].pid,signalled)
  finally:
   for child in children:
    if child.poll() is None:child.terminate()
    child.wait(timeout=3)
 def test_explicit_ipv6_sidecar_is_external_even_at_the_same_ipv4_port(self):
  with tempfile.TemporaryDirectory(prefix='heed-external-origin-') as directory:
   calls=[]
   def identity(base,service,root):
    calls.append((base,root));return {'service':'heed-transcription'} if base=='http://[::1]:48102' else None
   with patch.dict(os.environ,{'HEED_TRANSCRIPTION_URL':'http://[::1]:48102'}),patch.object(module,'read_identity',side_effect=identity),patch.object(module,'process_records',return_value=[]),patch.object(module,'occupied',return_value=False),patch.object(module.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout='')),patch.object(module.subprocess,'Popen',side_effect=AssertionError('must not launch another sidecar')):
    module.start(directory,{'transcription':48102},pathlib.Path(directory)/'logs',services=('transcription',))
   self.assertEqual(calls,[('http://[::1]:48102',None)])
 def test_failed_startup_reaps_already_exited_wrapper_listening_grandchild(self):
  self.assert_startup_tree_rollback(wrapper_exit=True)
 def assert_startup_tree_rollback(self,wrapper_exit):
  sockets=[];ports={}
  for name in ['api','ui','transcription']:
   sock=socket.socket();sock.bind(('127.0.0.1',0));ports[name]=sock.getsockname()[1];sockets.append(sock)
  for sock in sockets:sock.close()
  with tempfile.TemporaryDirectory(prefix='heed-start-tree-') as directory:
   marker=pathlib.Path(directory)/'grandchild.pid'
   grandchild=f"from http.server import HTTPServer,BaseHTTPRequestHandler;HTTPServer(('127.0.0.1',{ports['api']}),BaseHTTPRequestHandler).serve_forever()"
   wrapper=f"import subprocess,sys,time,pathlib\np=subprocess.Popen([sys.executable,'-c',{grandchild!r}])\npathlib.Path({str(marker)!r}).write_text(str(p.pid))\n"+ ("sys.exit(0)" if wrapper_exit else "time.sleep(60)")
   original=subprocess.Popen;children=[]
   def launch(*args,**kwargs):
    if args and args[0][0]=='ps':return original(*args,**kwargs)
    if children:
     deadline=time.monotonic()+15
     while time.monotonic()<deadline and not module.occupied(ports['api']):time.sleep(.02)
     self.assertTrue(marker.exists(),'fixture wrapper never spawned its child')
     self.assertTrue(module.occupied(ports['api']),'fixture grandchild must listen before rollback is triggered')
     raise OSError('injected second-service spawn failure')
    child=original([sys.executable,'-c',wrapper],cwd=directory,start_new_session=True)
    children.append(child);return child
   try:
    with patch.object(module,'process_records',return_value=[]),patch.object(module.subprocess,'Popen',side_effect=launch):
     with self.assertRaisesRegex(OSError,'second-service'):module.start(directory,ports,pathlib.Path(directory)/'logs')
    self.assertFalse(module.occupied(ports['api']),'startup rollback left a checkout-owned grandchild listener')
    checkpoint_path=pathlib.Path(self.app.name)/'service-startup.json'
    self.assertTrue(checkpoint_path.exists(),'Startup failures need a bounded private diagnostic checkpoint')
    checkpoint=json.loads(checkpoint_path.read_text())
    self.assertEqual(checkpoint['phase'],'failed','Failed startup must not leave a forever-starting notice')
    self.assertEqual(checkpoint['ports'],ports)
   finally:
    for child in children:
     try:os.killpg(child.pid,signal.SIGKILL)
     except (ProcessLookupError,PermissionError):pass
     child.wait()
 def test_legacy_owned_idle_processes_migrate_without_foreign_sidecar(self):
  records={5001:[{'pid':20,'cwd':'/qa','command':'bun run packages/server/server.ts'}],5170:[{'pid':21,'cwd':'/qa/packages/client','command':'node node_modules/vite/bin/vite.js'}],5002:[{'pid':99,'cwd':'/other','command':'ruby other.rb'}]}
  self.assertEqual(set(module.restart_plan('/qa',{'api':48100,'ui':48101,'transcription':48102},records,lambda port:{'recording':False,'processing':False,'pending':False,'starting':False})),{20,21})
if __name__=='__main__':unittest.main()
