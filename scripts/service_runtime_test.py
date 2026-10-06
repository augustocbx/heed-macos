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
   finally:
    for child in children:
     try:os.killpg(child.pid,signal.SIGKILL)
     except (ProcessLookupError,PermissionError):pass
     child.wait()
 def test_legacy_owned_idle_processes_migrate_without_foreign_sidecar(self):
  records={5001:[{'pid':20,'cwd':'/qa','command':'bun run packages/server/server.ts'}],5170:[{'pid':21,'cwd':'/qa/packages/client','command':'node node_modules/vite/bin/vite.js'}],5002:[{'pid':99,'cwd':'/other','command':'ruby other.rb'}]}
  self.assertEqual(set(module.restart_plan('/qa',{'api':48100,'ui':48101,'transcription':48102},records,lambda port:{'recording':False,'processing':False,'pending':False,'starting':False})),{20,21})
if __name__=='__main__':unittest.main()
