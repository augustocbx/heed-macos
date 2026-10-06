"""Validated loopback service configuration shared by Python and shell entrypoints."""
import json
import os
import pathlib
import re
import stat
import tempfile
import urllib.parse
ROOT=pathlib.Path(__file__).resolve().parent.parent
DEFAULTS=json.loads((ROOT/'config'/'service-ports.json').read_text())
def service_port(value,label):
 raw=str(value)
 if not re.fullmatch(r'[0-9]+',raw):raise ValueError(f'{label} must be a decimal TCP port.')
 port=int(raw)
 if not 1<=port<=65535 or any(first<=port<=last for first,last in DEFAULTS['forbiddenRanges']):raise ValueError(f'{label} must be 1–65535 outside 3000–3999, 5000–5999, 7000–7999 and 8000–8999.')
 return port
def saved_service_ports(env=None):
 env=os.environ if env is None else env
 path=pathlib.Path(env.get('HEED_APP_DIR',str(pathlib.Path.home()/'.heed-app')))/'service-ports.json'
 try:
  descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 except FileNotFoundError:return None
 except OSError as error:raise ValueError('Invalid device service ports. Preserve service-ports.json and repair its configuration.') from error
 try:
  info=os.fstat(descriptor)
  if not stat.S_ISREG(info.st_mode) or info.st_size>4096:raise ValueError()
  data=os.read(descriptor,4097)
  if len(data)>4096:raise ValueError()
  value=json.loads(data)
  if not isinstance(value,dict) or set(value)!=set(['version','api','ui','transcription']) or type(value['version']) is not int or value['version']!=1 or any(type(value[key]) is not int for key in ['api','ui','transcription']):raise ValueError()
  ports={key:service_port(value[key],f'Saved {key} port') for key in ['api','ui','transcription']}
  if len(set(ports.values()))!=3:raise ValueError()
  return ports
 except (ValueError,OSError) as error:raise ValueError('Invalid device service ports. Preserve service-ports.json and repair its configuration.') from error
 finally:os.close(descriptor)
def service_config(env=None):
 env=os.environ if env is None else env
 saved=saved_service_ports(env) or DEFAULTS
 if 'HEED_API_PORT' in env and 'PORT' in env and service_port(env['HEED_API_PORT'],'HEED_API_PORT')!=service_port(env['PORT'],'PORT'):raise ValueError('HEED_API_PORT and PORT disagree.')
 ports={'api':service_port(env.get('HEED_API_PORT',env.get('PORT',saved['api'])),'API port'),'ui':service_port(env.get('HEED_UI_PORT',saved['ui']),'Interface port'),'transcription':service_port(env.get('HEED_TRANSCRIPTION_PORT',saved['transcription']),'Transcription port')}
 if len(set(ports.values()))!=3:raise ValueError('Heed service ports must be distinct.')
 return ports
def save_service_ports(env=None):
 env=os.environ if env is None else env
 ports=service_config(env)
 directory=pathlib.Path(env.get('HEED_APP_DIR',str(pathlib.Path.home()/'.heed-app')))
 directory.mkdir(parents=True,exist_ok=True,mode=0o700)
 descriptor,temporary=tempfile.mkstemp(prefix='service-ports.',suffix='.tmp',dir=directory)
 try:
  with os.fdopen(descriptor,'w') as output:
   json.dump({'version':1,**ports},output);output.write('\n');output.flush();os.fsync(output.fileno())
  os.replace(temporary,directory/'service-ports.json')
  parent=os.open(directory,os.O_RDONLY)
  try:os.fsync(parent)
  finally:os.close(parent)
 finally:
  try:os.unlink(temporary)
  except FileNotFoundError:pass
 return ports
def local_service_url(value,label='Heed service'):
 url=urllib.parse.urlsplit(value)
 if url.scheme not in ('http','https') or url.hostname not in ('localhost','127.0.0.1','::1') or url.username or url.password or url.query or url.fragment or url.path not in ('','/'):raise ValueError(f'{label} must be a loopback origin without credentials, paths or queries.')
 service_port(url.port if url.port is not None else (443 if url.scheme=='https' else 80),f'{label} port')
 return urllib.parse.urlunsplit((url.scheme,url.netloc,'','',''))
def transcription_url(env=None):
 env=os.environ if env is None else env
 return local_service_url(env['HEED_TRANSCRIPTION_URL'],'Transcription service') if 'HEED_TRANSCRIPTION_URL' in env else f"http://127.0.0.1:{service_config(env)['transcription']}"
if __name__=='__main__':
 import argparse
 parser=argparse.ArgumentParser();parser.add_argument('service',choices=['api','ui','transcription']);parser.add_argument('--url',action='store_true');parser.add_argument('--client-url',action='store_true');parser.add_argument('--save',action='store_true');args=parser.parse_args()
 ports=save_service_ports() if args.save else service_config();print(transcription_url() if args.client_url and args.service=='transcription' else f'http://127.0.0.1:{ports[args.service]}' if args.url else ports[args.service])
