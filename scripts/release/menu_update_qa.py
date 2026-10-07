"""Explicit isolated UI fixture: real downloads/state/menu replacement, simulated services and installer."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

from installation_lock import InstallationLock
from release_updates import compare_versions, validate_manifest
from update_transaction import UpdateContext, TransactionDependencies, current_state, permission_outcome, run_update, save
import update_state


def atomic(path,value):
    descriptor, temporary=tempfile.mkstemp(dir=path.parent)
    with os.fdopen(descriptor,'w') as file:
        json.dump(value,file);file.flush();os.fsync(file.fileno())
    os.replace(temporary,path)


def fixture_root(path):
    root=Path(path).resolve()
    if not root.name.startswith('heed-menu-qa-') or root.stat().st_uid!=os.getuid() or root.stat().st_mode & 0o077:
        raise ValueError('Use a private isolated QA directory.')
    descriptor=os.open(root/'fixture.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(descriptor) as file:
        info=os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size>16384:raise ValueError('Invalid QA marker.')
        marker=json.load(file)
    if marker.get('fixtureOnly') is not True:raise ValueError('Missing explicit fixture marker.')
    return root,marker


def menu_permissions(root):
    """Read only the explicit QA scenario; never infer real macOS permissions."""
    default={'microphone':'denied','screenCapture':False,'slackLogs':False}
    path=root/'menu-state.json'
    try:
        descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except FileNotFoundError:
        return default
    with os.fdopen(descriptor,'rb') as file:
        info=os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_size>16384:
            raise ValueError('Invalid QA menu state file.')
        scenario=json.load(file)
    if (not isinstance(scenario,dict) or set(scenario)!={'control','fresh','microphone','screenCapture','services'}
        or scenario['control'] is not None and not isinstance(scenario['control'],dict)
        or type(scenario['fresh']) is not bool or type(scenario['screenCapture']) is not bool
        or scenario['microphone'] not in ['authorized','denied','restricted','notDetermined','unknown']
        or not isinstance(scenario['services'],list) or not all(isinstance(item,dict) for item in scenario['services'])):
        raise ValueError('Invalid QA menu state fields.')
    return {**default,'microphone':scenario['microphone'],'screenCapture':scenario['screenCapture']}


class AssetResponse(io.BytesIO):
    status=200
    headers={}


def prepare(binary):
    root=Path(tempfile.mkdtemp(prefix='heed-menu-qa-')).resolve()
    root.chmod(0o700)
    source=Path(__file__).resolve().parents[2]
    shutil.copytree(source/'scripts/release',root/'helpers/scripts/release',ignore=shutil.ignore_patterns('*_test.py','__pycache__'))
    (root/'helpers/config').mkdir()
    shutil.copyfile(source/'config/service-ports.json',root/'helpers/config/service-ports.json')
    for name in ['service_config.py','service_runtime.py']:
        shutil.copyfile(source/'scripts'/name,root/'helpers/scripts'/name)
    home=root/'home'; home.mkdir(mode=0o700)
    (home/'.heed').mkdir(mode=0o700);(home/'app').mkdir(mode=0o700)
    old=home/'.heed/runtime/versions/0.1.0';old.mkdir(parents=True)
    (home/'.heed/runtime/current').symlink_to(old)
    (old/'VERSION').write_text('0.1.0\n')
    old_metadata={'app':'heed','version':'0.1.0','commit':'a'*40}
    (old/'release.json').write_text(json.dumps(old_metadata))
    sentinels={'recording.wav':b'synthetic audio', 'meeting.json':b'{"transcript":"Synthetic meeting","speaker":"Ada"}',
               'settings.json':b'{"locale":"pt-BR"}', 'models.cache':b'synthetic model sentinel', 'private-state.json':b'synthetic connection sentinel'}
    data=home/'app'
    for name,value in sentinels.items():(data/name).write_bytes(value)
    app=root/'Heed QA.app';resources=app/'Contents/Resources';resources.mkdir(parents=True)
    (app/'Contents/MacOS').mkdir();shutil.copyfile(binary,app/'Contents/MacOS/Heed');(app/'Contents/MacOS/Heed').chmod(0o755)
    identifier='local.heed.menu-qa.'+uuid.uuid4().hex
    with (app/'Contents/Info.plist').open('wb') as file:
        plistlib.dump({'CFBundleIdentifier':identifier,'CFBundleName':'Heed Update QA','CFBundleExecutable':'Heed',
                      'CFBundlePackageType':'APPL','CFBundleShortVersionString':'0.1.0','LSUIElement':True},file)
    for name,value in [('heed-root',str(old)),('heed-home',str(home/'.heed')),('heed-app-dir',str(data))]:
        (resources/(name+'.txt')).write_text(value+'\n')
    (resources/'release.json').write_text(json.dumps(old_metadata))
    ports=json.loads((source/'config/service-ports.json').read_text());ports.update(api=48870,ui=48871,transcription=48872)
    (resources/'service-ports.json').write_text(json.dumps(ports))
    manifest={'schema':1,'app':'heed','version':'0.1.1','tag':'v0.1.1','commit':'b'*40,'repository':'augustocbx/heed-macos',
              'architectures':['arm64'],'minimumMacOS':'14.0','assets':{}}
    assets=root/'assets';assets.mkdir()
    (assets/'install.sh').write_text('#!/bin/bash\n# Local UI fixture only.\nexit 0\n')
    archive=assets/'heed-macos-0.1.1-arm64.tar.gz'
    raw=json.dumps({key:value for key,value in manifest.items() if key!='assets'}).encode()
    with tarfile.open(archive,'w:gz') as file:
        member=tarfile.TarInfo('heed-macos-0.1.1-arm64/release.json');member.size=len(raw);member.mode=0o600
        file.addfile(member,io.BytesIO(raw))
    for kind,name in [('installer','install.sh'),('payload',archive.name)]:
        value=(assets/name).read_bytes();manifest['assets'][kind]={'name':name,'size':len(value),'sha256':hashlib.sha256(value).hexdigest(),
            'url':'https://github.com/augustocbx/heed-macos/releases/download/v0.1.1/'+name}
    marker={'fixtureOnly':True,'bundleId':identifier,'release':{'manifest':manifest,'notesURL':'https://github.com/augustocbx/heed-macos/releases/tag/v0.1.1'},
            'sentinels':{name:hashlib.sha256(value).hexdigest() for name,value in sentinels.items()}}
    atomic(root/'fixture.json',marker)
    subprocess.run(['codesign','--force','--sign','-',str(app)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    print(root)


def main():
    if sys.argv[1:2]==['prepare']:
        prepare(sys.argv[2]);return
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['check','install','worker','status','recover','permissions','verify','stop'])
    for flag in ['root','home','app-dir','version','commit','architecture','macos','fixture','instance-id','menu-pid']:
        parser.add_argument('--'+flag)
    parser.add_argument('--automatic',action='store_true');args=parser.parse_args()
    root,marker=fixture_root(args.fixture)
    home=root/'home/.heed'; data=root/'home/app'
    context=UpdateContext((home/'runtime/current').resolve(),home,data,args.version or '0.1.0',args.commit or 'a'*40,'arm64','14.0')
    release=marker['release'];manifest=release['manifest'];validate_manifest(manifest,'0.1.1','arm64','14.0')
    state=current_state(context)
    report_path=root/'qa-permissions.json'
    if args.command in ['status','permissions'] and args.menu_pid:
        atomic(report_path,{'controllerConnected':True,'updatedAt':time.time()*1000,'pid':int(args.menu_pid),
                          'build':{'version':args.version,'commit':args.commit,'instanceId':args.instance_id},
                          'permissions':menu_permissions(root)})
    def stop_menu():
        if not report_path.exists():return
        pid=json.loads(report_path.read_text())['pid']
        command=subprocess.run(['ps','-p',str(pid),'-o','command='],capture_output=True,text=True).stdout.strip()
        expected=str(root/'Heed QA.app/Contents/MacOS/Heed')
        if command.startswith(expected+' ') and '--update-qa '+str(root) in command:
            os.kill(pid,signal.SIGTERM)
            for _ in range(50):
                try:os.kill(pid,0)
                except ProcessLookupError:return
                time.sleep(.1)
    def install_fixture(ctx,script,payload,lock,transaction,owner):
        save(ctx,{**current_state(ctx),'phase':'restarting'})
        target=home/'runtime/versions/0.1.1';target.mkdir()
        metadata=json.loads((payload/'release.json').read_text())
        (target/'release.json').write_text(json.dumps(metadata));(target/'VERSION').write_text('0.1.1\n')
        link=home/'runtime/current.new';link.symlink_to(target);os.replace(link,home/'runtime/current')
        app=root/'Heed QA.app';resources=app/'Contents/Resources'
        stop_menu()
        binary=app/'Contents/MacOS/Heed';shutil.copyfile(binary,binary.with_suffix('.new'));binary.with_suffix('.new').chmod(0o755);os.replace(binary.with_suffix('.new'),binary)
        info=plistlib.loads((app/'Contents/Info.plist').read_bytes());info['CFBundleShortVersionString']='0.1.1';(app/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
        (resources/'release.json').write_text(json.dumps(metadata));(resources/'heed-root.txt').write_text(str(target)+'\n')
        subprocess.run(['codesign','--force','--sign','-',str(app)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.Popen([str(binary),'--update-qa',str(root)],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            if report_path.exists() and json.loads(report_path.read_text()).get('build',{}).get('version')=='0.1.1':return 0
            time.sleep(.2)
        return 1
    def verify_services(ctx,version,commit):
        value=json.loads((home/'runtime/current/release.json').read_text())
        return value['version']==version and value['commit']==commit
    dependencies=TransactionDependencies(transport=lambda url,timeout:AssetResponse((root/'assets'/url.rsplit('/',1)[1]).read_bytes()),
        activity=lambda ctx:{'maintenanceProtocol':2,'processingKinds':[]},maintenance=lambda *args:None,
        services=verify_services,permissions=lambda ctx:json.loads(report_path.read_text()) if report_path.exists() else None,installer=install_fixture)
    if args.command=='check':
        with InstallationLock(home):
            state=save(context,{**state,'state':'available' if compare_versions('0.1.1',context.installed_version)>0 else 'upToDate',
                                'release':release,'lastAutomaticAttempt':time.time()})
    elif args.command=='install':
        with InstallationLock(home) as lock:
            transaction=str(uuid.uuid4());update_state.directory(home,transaction)
            state=save(context,{**state,'transactionId':transaction,'owner':str(uuid.uuid4()),'phase':'downloading'})
            with (root/'coordinator.log').open('ab') as log:
                subprocess.Popen([sys.executable,__file__,'worker',*sys.argv[2:]],env={**os.environ,'HEED_INSTALL_LOCK_FD':str(lock.fd)},
                                 pass_fds=(lock.fd,),start_new_session=True,stdin=subprocess.DEVNULL,stdout=log,stderr=log)
    elif args.command=='worker':
        state=run_update(context,release,dependencies,transaction=state['transactionId'],inherited_fd=int(os.environ['HEED_INSTALL_LOCK_FD']))
    elif args.command=='permissions':state=save(context,{**state,**permission_outcome(json.loads(report_path.read_text()),'0.1.1','b'*40)})
    elif args.command=='verify':
        report=json.loads(report_path.read_text())
        expected=menu_permissions(root)
        assert all(report['permissions'][key]==value for key,value in expected.items()),report
        outcome=permission_outcome(report,'0.1.1','b'*40,now=report['updatedAt']/1000)
        assert state['phase']=='completed' and state['verifiedVersion']=='0.1.1',state
        assert state['permissionState']==outcome['permissionState'] and state['missingPermissions']==outcome['missingPermissions'],state
        assert all(hashlib.sha256((data/name).read_bytes()).hexdigest()==digest for name,digest in marker['sentinels'].items())
        print('QA menu replacement, matching permission report and synthetic data preservation passed.');return
    elif args.command=='stop':stop_menu();return
    print(json.dumps(state))


if __name__=='__main__':main()
