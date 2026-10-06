"""Start/restart only checkout-owned services; an unrelated listener is never readiness."""
import argparse
import json
import os
import pathlib
import re
import shlex
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.parse
from lifecycle_metadata import BUSY_KEYS, read_status, request as lifecycle_request, valid_identity
from service_config import service_config,saved_service_ports,transcription_url,ROOT
HEALTH={'api':'/.well-known/heed-service','ui':'/.well-known/heed-service','transcription':'/health'}
NAMES={'api':'heed-api','ui':'heed-ui','transcription':'heed-transcription'}
LEGACY={'api':5001,'ui':5170,'transcription':5002}
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):return None
def separately_managed_transcription(url,configured_port):
 parsed=urllib.parse.urlsplit(url)
 port=parsed.port or (443 if parsed.scheme=='https' else 80)
 return parsed.scheme!='http' or parsed.hostname not in ('127.0.0.1','localhost') or port!=configured_port
def read_identity(base,service,root,timeout=2):
 try:
  opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
  endpoint='/health' if service=='heed-transcription' else '/.well-known/heed-service'
  with opener.open(base+endpoint,timeout=timeout) as response:
   if response.status!=200:return None
   body=response.read(65537)
  if len(body)>65536:return None
  data=json.loads(body)
  if not isinstance(data,dict) or not isinstance(data.get('checkoutRoot'),str) or not data['checkoutRoot'].startswith('/'):return None
  if data.get('service')!=service or (type(data.get('protocolVersion')) is not int or data.get('protocolVersion')!=1) or (root is not None and os.path.realpath(data.get('checkoutRoot',''))!=os.path.realpath(root)) or type(data.get('pid')) is not int or data['pid']<=0:return None
  if service=='heed-transcription' and not all(type(data.get(key)) is bool for key in ['ready','whisper','pyannote']):return None
  return data
 except (OSError,ValueError,TypeError):return None
def occupied(port):
 with socket.socket() as sock:
  sock.settimeout(.2)
  return sock.connect_ex(('127.0.0.1',port))==0

def python_arguments(root,cwd,command,entry):
 try:args=shlex.split(command)
 except ValueError:return None
 if not args:return None
 executable=pathlib.Path(args.pop(0)).name
 if executable!='Python' and not re.fullmatch(r'python(?:3(?:\.\d+)?)?',executable):return None
 if args and args[0]=='-u':args.pop(0)
 if not args or os.path.realpath(os.path.join(cwd,args.pop(0)))!=os.path.join(os.path.realpath(root),entry):return None
 return args

def owned_process(root,service,cwd,command):
 root=os.path.realpath(root);cwd=os.path.realpath(cwd)
 if cwd not in (root,os.path.join(root,'packages','client'),os.path.join(root,'packages','server'),os.path.join(root,'packages','transcription')):return False
 if service=='api':
  if cwd not in (root,os.path.join(root,'packages','server')):return False
  try:args=shlex.split(command)
  except ValueError:return False
  if not args or pathlib.Path(args.pop(0)).name!='bun':return False
  flags=0
  if args and args[0] in ('--watch','--hot'):args.pop(0);flags+=1
  if args and args[0]=='run':args.pop(0)
  if args and args[0] in ('--watch','--hot'):args.pop(0);flags+=1
  if flags>1 or len(args)!=1:return False
  target=args[0]
  if target=='dev:server':return cwd==root
  return os.path.realpath(os.path.join(cwd,target))==os.path.join(root,'packages','server','server.ts')
 if service=='transcription':
  return cwd in (root,os.path.join(root,'packages','transcription')) and python_arguments(root,cwd,command,'packages/transcription/transcription_server.py')==[]
 return cwd==os.path.join(root,'packages','client') and bool(re.search(r'(?:^|[ /])vite(?:/bin/vite\.js)?(?:\s|$)',command))
def process_records(port,timeout=None):
 if sys.platform!='darwin':
  # Linux desktop support: correlate listening socket inodes with process fds.
  inodes=set()
  for table in ['/proc/net/tcp','/proc/net/tcp6']:
   try:
    for line in pathlib.Path(table).read_text().splitlines()[1:]:
     fields=line.split()
     if fields[3]=='0A' and int(fields[1].split(':')[1],16)==port:inodes.add(fields[9])
   except (OSError,ValueError,IndexError):pass
  records=[]
  for process in pathlib.Path('/proc').iterdir():
   if not process.name.isdigit():continue
   try:
    if not any(os.readlink(fd) in {f'socket:[{inode}]' for inode in inodes} for fd in (process/'fd').iterdir()):continue
    records.append({'pid':int(process.name),'cwd':os.readlink(process/'cwd'),'command':(process/'cmdline').read_bytes().replace(b'\0',b' ').decode().strip()})
   except (OSError,UnicodeError):continue
  return records
 output=subprocess.run(['/usr/sbin/lsof','-t','-nP',f'-iTCP:{port}','-sTCP:LISTEN'],capture_output=True,text=True,timeout=timeout).stdout
 records=[]
 for value in set(output.split()):
  if not value.isdigit():continue
  pid=int(value)
  cwd=subprocess.run(['/usr/sbin/lsof','-a','-p',str(pid),'-d','cwd','-Fn'],capture_output=True,text=True,timeout=timeout).stdout
  paths=[line[1:] for line in cwd.splitlines() if line.startswith('n')]
  command=subprocess.run(['ps','-ww','-p',str(pid),'-o','command='],capture_output=True,text=True,timeout=timeout).stdout.strip()
  records.append({'pid':pid,'cwd':paths[0] if paths else '', 'command':command})
 return records
def verified_api_identity(base,root):
 code,identity=lifecycle_request(base,'/.well-known/heed-service',max_bytes=65536,timeout=2)
 if code!=200 or not valid_identity(identity,root):raise ValueError('The configured API listener has no matching Heed identity. No control request was sent.')
 port=urllib.parse.urlsplit(base).port
 records=process_records(port,timeout=2)
 if not records or not all(entry['pid']==identity['pid'] and owned_process(root,'api',entry['cwd'],entry['command']) for entry in records):raise ValueError('The API identity does not match its independently owned listener. No control request was sent.')
 return identity
def status(port,root=None):
 root=str(ROOT) if root is None else root
 base=f'http://127.0.0.1:{port}'
 return read_status(base,verified_api_identity(base,root))
def control_targets(root,ports,records,previous=None):
 targets=[]
 for port in set([ports['api'],LEGACY['api'],*([] if previous is None else [previous['api']])]):
  for entry in records.get(port,[]):
   if owned_process(root,'api',entry['cwd'],entry['command']):targets.append(port)
   elif port==ports['api']:raise RuntimeError(f'Heed API port {port} belongs to another application. No control request was sent.')
 return list(set(targets))
def restart_plan(root,ports,records,get_status,previous=None):
 plan=[];api_ports=[]
 for service,port in ports.items():
  for entry in records.get(port,[]):
   if not owned_process(root,service,entry['cwd'],entry['command']):raise RuntimeError(f'Heed {service} port {port} belongs to another application. Its process was not stopped; choose an allowed HEED service port.')
   plan.append(entry['pid'])
   if service=='api':api_ports.append(port)
 for profile in [LEGACY,previous or {}]:
  for service,port in profile.items():
   for entry in records.get(port,[]):
    if owned_process(root,service,entry['cwd'],entry['command']):
     plan.append(entry['pid'])
     if service=='api':api_ports.append(port)
 for port in set(api_ports):
  state=get_status(port)
  if not all(type(state.get(key)) is bool for key in BUSY_KEYS):raise RuntimeError('Could not verify checkout-owned Heed recording status. No services were stopped.')
  if any(state[key] for key in BUSY_KEYS):raise RuntimeError('An active meeting prevents restarting Heed services.')
 return list(set(plan))
def restart(root,ports):
 previous=saved_service_ports()
 records={port:process_records(port) for port in set(ports.values())|set(LEGACY.values())|set((previous or {}).values())}
 plan=restart_plan(root,ports,records,lambda port:status(port,root),previous)
 # All ownership and busy checks complete before the first termination.
 for pid in plan:
  current=subprocess.run(['ps','-ww','-p',str(pid),'-o','command='],capture_output=True,text=True).stdout.strip()
  matches=[(service,entry) for service,port in {**ports}.items() for entry in records.get(port,[]) if entry['pid']==pid]
  matches.extend((service,entry) for profile in [LEGACY,previous or {}] for service,port in profile.items() for entry in records.get(port,[]) if entry['pid']==pid)
  if not matches or not any(current==entry['command'] and owned_process(root,service,entry['cwd'],current) for service,entry in matches):raise RuntimeError('Heed process ownership changed before restart. No unrelated process was stopped.')
  try:os.kill(pid,signal.SIGTERM)
  except ProcessLookupError:pass
 deadline=time.monotonic()+10
 while time.monotonic()<deadline:
  if all(not subprocess.run(['ps','-p',str(pid),'-o','pid='],capture_output=True,text=True).stdout.strip() for pid in plan):return
  time.sleep(.1)
 raise RuntimeError('Checkout-owned services did not stop. Preserve processes and retry after completing active work.')
def owned_group_members(group):
 # The bootstrap created this session with start_new_session=True. Live members
 # keep its kernel session/group identity; exclude zombies, which cannot listen.
 result=subprocess.run(['ps','-axo','pid=,pgid=,uid=,stat='],capture_output=True,text=True,timeout=2)
 if result.returncode!=0:raise RuntimeError('Could not verify newly started service ownership for rollback.')
 members=[]
 for row in result.stdout.splitlines():
  values=row.split()
  if len(values)!=4 or not all(value.isdigit() for value in values[:3]):continue
  pid,pgid,uid=map(int,values[:3])
  if pgid!=group or values[3].startswith('Z'):continue
  try:session=os.getsid(pid)
  except ProcessLookupError:continue
  if uid!=os.geteuid() or session!=group:raise RuntimeError('New service group ownership changed. No unrelated process was stopped.')
  members.append(pid)
 return members
def signal_owned_group(group,kind):
 if not owned_group_members(group):return False
 try:os.killpg(group,kind);return True
 except ProcessLookupError:return False
 except PermissionError:
  if not owned_group_members(group):return False
  raise
def rollback_children(children):
 unverified=set()
 failures=False
 def attempt(group,kind):
  nonlocal failures
  try:signal_owned_group(group,kind)
  except (OSError,RuntimeError,subprocess.TimeoutExpired):unverified.add(group);failures=True
 for child in children:attempt(child.pid,signal.SIGTERM)
 deadline=time.monotonic()+5
 for child in children:
  if child.pid in unverified:continue
  try:child.wait(timeout=max(0,deadline-time.monotonic()))
  except subprocess.TimeoutExpired:pass
 remaining={child.pid for child in children if child.pid not in unverified}
 while remaining and time.monotonic()<deadline:
  for group in list(remaining):
   try:
    if not owned_group_members(group):remaining.remove(group)
   except (OSError,RuntimeError,subprocess.TimeoutExpired):
    unverified.add(group);remaining.remove(group);failures=True
  if remaining:time.sleep(.05)
 for group in remaining:attempt(group,signal.SIGKILL)
 deadline=time.monotonic()+5
 for child in children:
  if child.pid in unverified:continue
  try:child.wait(timeout=max(0,deadline-time.monotonic()))
  except subprocess.TimeoutExpired:failures=True
 if failures:raise RuntimeError('New service cleanup could not be verified completely. Unverified processes were preserved; inspect startup before retrying.')
def start(root,ports,log_dir,services=('api','ui','transcription')):
 from service_diagnostics import record_startup
 selected={name:ports[name] for name in services}
 record_startup(root,selected,'starting')
 try:
  _start(root,ports,log_dir,services)
  record_startup(root,selected,'ready')
 except BaseException:
  record_startup(root,selected,'failed')
  raise
def _start(root,ports,log_dir,services=('api','ui','transcription')):
 ports={name:ports[name] for name in services}
 log_dir.mkdir(parents=True,exist_ok=True)
 ready={}
 external=os.environ.get('HEED_TRANSCRIPTION_URL')
 external_url=transcription_url() if external else None
 parsed=urllib.parse.urlsplit(external_url) if external_url else None
 separately_managed=parsed is not None and separately_managed_transcription(external_url,ports.get('transcription'))
 if 'transcription' in ports and separately_managed:
  if not read_identity(external_url,'heed-transcription',None):raise RuntimeError('The explicitly configured transcription service has no valid Heed identity. Start that separately managed sidecar before Heed.')
  ready['transcription']=True
 # Preflight every target, so one foreign listener cannot leave a partially started stack.
 for service,port in ports.items():
  if ready.get(service):continue
  base=f'http://127.0.0.1:{port}'
  identity=read_identity(base,NAMES[service],root)
  ready[service]=bool(identity)
  if identity:
   records=process_records(port)
   if not any(entry['pid']==identity['pid'] and owned_process(root,service,entry['cwd'],entry['command']) for entry in records):raise RuntimeError(f'Heed {service} identity does not match its checkout-owned listener. No new service was started.')
  elif occupied(port):raise RuntimeError(f'Heed {service} port {port} is occupied by an unverified application. Preserve it and choose an allowed HEED service port.')
 legacy={port:process_records(port) for port in LEGACY.values()}
 if any(owned_process(root,service,entry['cwd'],entry['command']) for service,port in LEGACY.items() for entry in legacy[port]):raise RuntimeError('Checkout-owned services still use former ports. Run install-macos.sh while idle to migrate safely; no duplicate sidecar was started.')
 commands={'api':['bun','run','packages/server/server.ts'],'ui':['bun','run','--cwd','packages/client','dev'],'transcription':[str(pathlib.Path(root)/'.venv/bin/python3'),'-u','packages/transcription/transcription_server.py']}
 children=[]
 try:
  for service,command in commands.items():
   if service not in ports or ready[service]:continue
   if service=='transcription':
    doctor=subprocess.run(['pgrep','-f',re.escape(str(pathlib.Path(root)/'packages/transcription/doctor.py'))],capture_output=True,text=True)
    if doctor.stdout.strip():raise RuntimeError('This checkout is warming models with doctor.py. Retry bootstrap when it finishes.')
   with (log_dir/f'{service}.log').open('ab') as log:
    child=subprocess.Popen(command,cwd=root,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
   children.append(child)
  deadline=time.monotonic()+30
  while time.monotonic()<deadline:
   if any(child.poll() is not None for child in children):raise RuntimeError('A Heed service exited during startup. Check the service log; no unrelated listener was stopped.')
   if all(ready[service] or read_identity(f'http://127.0.0.1:{port}',NAMES[service],root) for service,port in ports.items()):return
   time.sleep(.2)
  raise RuntimeError('Heed identity readiness timed out. Check the service logs and configured ports.')
 except BaseException:
  # Every newly launched service owns a fresh session. Wrappers may exit before
  # their Vite/Bun descendants, so cleanup must retain the owned group identity.
  rollback_children(children)
  raise
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('action',choices=['start','restart']);parser.add_argument('--root',default=str(ROOT));parser.add_argument('--log-dir',default=str(pathlib.Path.home()/'Library/Logs/Heed'));args=parser.parse_args()
 try:
  ports=service_config();root=os.path.realpath(args.root)
  if root!=str(ROOT):raise RuntimeError('Bootstrap root does not match this service helper checkout.')
  if args.action=='restart':restart(root,ports)
  else:start(root,ports,pathlib.Path(args.log_dir))
 except (ValueError,OSError,RuntimeError) as error:sys.exit(str(error))
