"""Detached, explicit release updates. Runs with the macOS system Python."""
import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

import heed_release
from installation_lock import InstallationLock
from release_updates import check_release, compare_versions, download_verified, transport, validate_archive, validate_manifest, UpdateError
import update_state

ACTIVE = {'downloading','verifying','installing','restarting','checkingServices','checkingPermissions'}


@dataclass
class UpdateContext:
    root: Path
    home: Path
    app_dir: Path
    installed_version: str
    installed_commit: str
    architecture: str
    macos: str


def private_home(context):
    home = context.home
    # InstallationLock applies the dedicated-folder rule even to status readers.
    from installation_lock import lock_path
    lock_path(home)
    if not home.is_absolute() or home.is_symlink(): raise ValueError('Invalid update directory.')
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = home.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('The update directory must be private and owned by this user.')
    for container in [home/'runtime',home/'runtime/versions']:
        if container.is_symlink():raise ValueError('Installed runtime containers cannot be symbolic links.')
    return home


def current_state(context):
    path = private_home(context) / 'update.json'
    try: fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return {'schema':1,'state':'notChecked','phase':None,'installedVersion':context.installed_version,'permissionState':'unknown'}
    except OSError as error: raise ValueError('Update status could not be read safely.') from error
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 2*1024*1024:
            raise ValueError('Invalid update status file.')
        data = json.loads(os.read(fd, 2*1024*1024+1))
        if not isinstance(data, dict) or type(data.get('schema')) is not int or data['schema'] != 1:
            raise ValueError('Invalid update status schema.')
        if data.get('transactionId') and str(uuid.UUID(data['transactionId'])) != data['transactionId']:
            raise ValueError('Invalid update transaction.')
        if data.get('logPath') is not None:
            expected= context.home/'updates'/str(data.get('transactionId'))/'update.log'
            if data['logPath']!=str(expected):raise ValueError('Invalid update log path.')
        return data
    finally: os.close(fd)


def save(context, state):
    home = private_home(context); path = home / 'update.json'
    if path.is_symlink(): raise ValueError('Update status cannot be a symbolic link.')
    state = {**state,'schema':1,'updatedAt':time.time()}
    fd, temporary = tempfile.mkstemp(prefix='.update-', dir=home)
    try:
        with os.fdopen(fd, 'w') as file:
            json.dump(state,file); file.flush(); os.fsync(file.fileno())
        os.replace(temporary,path)
        parent=os.open(home,os.O_RDONLY)
        try: os.fsync(parent)
        finally: os.close(parent)
        if state.get('transactionId'):
            update_state.write(home,state['transactionId'],'status.json',state)
        return state
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def configuration(context):
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
    from service_config import service_config
    return service_config({**os.environ,'HEED_APP_DIR':str(context.app_dir)})


def base(context): return 'http://127.0.0.1:%d' % configuration(context)['api']


def activity(context):
    ports=configuration(context)
    from service_config import transcription_url
    from service_runtime import separately_managed_transcription
    if separately_managed_transcription(transcription_url({**os.environ,'HEED_APP_DIR':str(context.app_dir)}),ports['transcription']):
        raise UpdateError('unsupported-maintenance','Menu updates require their own versioned transcription service. Preserve the separate service and use the checkout workflow.')
    origin=base(context)
    if heed_release.service_identity(origin,'heed-api',context.root) is None:
        raise UpdateError('unverified-service','The expected Heed API must be running before updating.')
    status,data,_=heed_release.fetch_json(origin+'/api/desktop/control/status')
    if status != 200 or not isinstance(data,dict) or not all(type(data.get(key)) is bool for key in heed_release.BUSY_KEYS):
        raise UpdateError('unverified-service','Heed did not return complete processing status.')
    if any(data[key] for key in heed_release.BUSY_KEYS):
        data={**data,'processingKinds':[*data.get('processingKinds',[]),'audioWork']}
    return data


def maintenance(context,owner,transaction,acquire):
    origin=base(context)
    if heed_release.service_identity(origin,'heed-api',context.root) is None:
        raise UpdateError('unverified-service','The maintenance endpoint does not belong to this Heed build.')
    status,data,_=heed_release.fetch_json(origin+'/api/recording/maintenance', method='POST',
                                         body={'owner':owner,'transactionId':transaction,'acquire':acquire})
    if status != 200 or not isinstance(data,dict) or data.get('maintenanceProtocol') != 2 or data.get('maintenance') is not acquire or data.get('updateTransactionId') != (transaction if acquire else None):
        raise UpdateError('maintenance-failed','Could not acknowledge the matching update maintenance lease.')


def services(context,version,commit):
    ports=configuration(context)
    result=heed_release.check_services(version,ports['api'],ports['ui'],ports['transcription'],commit,str(context.root))
    identity=heed_release.service_identity('http://127.0.0.1:%d'%ports['transcription'],'heed-transcription',context.root)
    return all(value is None for value in result.values()) and identity is not None and identity.get('whisper') is True


def permissions(context):
    origin=base(context)
    if heed_release.service_identity(origin,'heed-api',context.root) is None: return None
    status,data,_=heed_release.fetch_json(origin+'/api/desktop/permissions')
    return data if status == 200 else None


def permission_outcome(report,version,commit,now=None):
    result={'permissionState':'unknown','missingPermissions':[],'optionalAccess':[]}
    now=time.time() if now is None else now
    if not isinstance(report,dict): return result
    build=report.get('build'); p=report.get('permissions'); timestamp=report.get('updatedAt')
    if (report.get('controllerConnected') is not True or not isinstance(timestamp,(int,float)) or isinstance(timestamp,bool)
        or not 0 <= now*1000-timestamp < 12000 or not isinstance(build,dict) or build.get('version') != version
        or build.get('commit') != commit or not isinstance(build.get('instanceId'),str) or not build['instanceId']
        or not isinstance(p,dict) or p.get('microphone') not in ['authorized','denied','restricted','notDetermined','unknown']
        or type(p.get('screenCapture')) is not bool): return result
    if p['microphone'] != 'authorized': result['missingPermissions'].append('microphone')
    if p['screenCapture'] is not True: result['missingPermissions'].append('screenCapture')
    if p.get('slackLogs') is False: result['optionalAccess'].append('slackLogs')
    result['permissionState']='restricted' if p['microphone']=='restricted' else 'unknown' if p['microphone']=='unknown' else 'attention' if result['missingPermissions'] else 'authorized'
    return result


def extract_payload(archive,directory,name):
    # validate_archive rejects links, special entries, duplicates and escaping paths first.
    with tarfile.open(archive,'r:gz') as payload: payload.extractall(directory)
    return directory / name


def discard_payloads(context,state):
    """Keep diagnostics and recovery material; discard only a safe transaction's assets."""
    if state.get('recovery') == 'recoveryRequired': return state
    try:
        manifest=state['release']['manifest']
        validate_manifest(manifest,manifest['version'],context.architecture,context.macos)
        folder=update_state.directory(context.home,state['transactionId'])
        names=[manifest['assets'][kind]['name'] for kind in ['installer','payload']]
        names.append('heed-macos-%s-arm64' % manifest['version'])
        for name in names:
            path=folder/name
            if path.is_symlink(): raise ValueError('Update assets cannot be symbolic links.')
            if path.is_dir(): shutil.rmtree(path)
            elif path.exists(): path.unlink()
    except (OSError,ValueError,KeyError) as error:
        # Cleanup must not change a verified installation outcome.
        return save(context,{**state,'cleanupWarning':str(error)})
    return state


def installer(context,script,payload,lock,transaction,owner):
    folder=update_state.directory(context.home,transaction)
    environment={**os.environ,'HEED_HOME':str(context.home),'HEED_APP_DIR':str(context.app_dir),
                 'HEED_INSTALL_LOCK_FD':str(lock.fd),'HEED_UPDATE_TRANSACTION_ID':transaction,
                 'HEED_LIFECYCLE_GUARD_TOKEN':owner}
    descriptor=os.open(folder/'update.log',os.O_WRONLY|os.O_CREAT|os.O_APPEND|os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'ab',buffering=0) as log:
        child=subprocess.Popen(['/bin/bash',str(script),'--payload',str(payload),'--no-permission-prompt'],
                               env=environment,pass_fds=(lock.fd,),stdout=log,stderr=log,start_new_session=True)
        while child.poll() is None:
            event=update_state.read(context.home,transaction,'installer-phase.json')
            state=current_state(context)
            if event and event.get('phase') in ACTIVE and state.get('transactionId')==transaction and state.get('phase')!=event['phase']:
                save(context,{**state,'phase':event['phase']})
            time.sleep(.5)
        return child.returncode


@dataclass
class TransactionDependencies:
    transport: object = transport
    clock: object = time.time
    installer: object = installer
    activity: object = activity
    maintenance: object = maintenance
    services: object = services
    permissions: object = permissions


def verified_context(context,state):
    root=(context.home/'runtime/current').resolve()
    versions=(context.home/'runtime/versions').resolve()
    if (context.home/'runtime/current').exists() and versions not in root.parents:
        raise UpdateError('recovery-required','The current runtime is outside the owned versions directory.')
    # A retained or restored runtime must match a build recorded before replacement.
    allowed=[(state['targetVersion'],state['targetCommit']), (state['installedVersion'],state.get('installedCommit'))]
    candidates=[root,Path(state['installedRoot'])]
    for candidate in candidates:
        try:
            descriptor=os.open(candidate/'release.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            with os.fdopen(descriptor,'rb') as file:
                value=json.loads(file.read(16385))
            for version,commit in allowed:
                if value.get('app')=='heed' and value.get('version')==version and value.get('commit')==commit:
                    return UpdateContext(candidate,context.home,context.app_dir,version,commit,context.architecture,context.macos)
        except (OSError,ValueError): pass
    raise UpdateError('recovery-required','The retained runtime identity could not be verified.')


def finish_verification(context,state,deps,exit_code):
    retained=verified_context(context,state) if deps.services is services else context
    version=retained.installed_version if deps.services is services else state['targetVersion']
    commit=retained.installed_commit if deps.services is services else state['targetCommit']
    if not deps.services(retained,version,commit):
        return save(context,{**state,'phase':'failed','errorCode':'service-verification-failed','recovery':'recoveryRequired'})
    target=version==state['targetVersion'] and commit==state['targetCommit']
    state=save(context,{**state,'phase':'checkingPermissions'})
    deadline=time.monotonic()+60
    while True:
        outcome=permission_outcome(deps.permissions(retained),version,commit,deps.clock())
        if outcome['permissionState']!='unknown' or deps.permissions is not permissions or time.monotonic()>=deadline:
            break
        time.sleep(1)
    state=save(context,{**state,**outcome,'phase':'checkingPermissions',
                        'errorCode':None if exit_code==0 and target else 'installation-failed',
                        'recovery':'retainedTarget' if target else 'restored','verifiedVersion':version,'verifiedCommit':commit,'permissionVersion':version})
    if deps.activity is activity:
        lease=deps.activity(retained)
        if lease.get('maintenance') and lease.get('updateTransactionId')!=state['transactionId']:
            raise UpdateError('maintenance-failed','Another maintenance owner must not be released.')
        if lease.get('updateTransactionId')==state['transactionId']:
            deps.maintenance(retained,state['owner'],state['transactionId'],False)
    else:
        deps.maintenance(retained,state['owner'],state['transactionId'],False)
    return discard_payloads(context,save(context,{**state,'phase':'completed' if exit_code==0 and target else 'failed'}))


def run_update(context,release,dependencies=None,transaction=None,inherited_fd=None):
    deps=dependencies or TransactionDependencies()
    with InstallationLock(context.home,inherited_fd) as lock:
        prior=current_state(context)
        if transaction is None and prior.get('phase') in ACTIVE:
            raise UpdateError('recovery-required','Reconcile the interrupted update before retrying.')
        transaction=transaction or str(uuid.uuid4()); owner=prior.get('owner') if prior.get('transactionId')==transaction else str(uuid.uuid4())
        folder=update_state.directory(context.home,transaction)
        state={**prior,'transactionId':transaction,'owner':owner,'coordinatorPid':os.getpid(),
               'installedVersion':context.installed_version,'installedCommit':context.installed_commit,'installedRoot':str(context.root),
               'phase':'downloading','permissionState':'unknown','progress':None,'release':release,'state':'available',
               'errorCode':None,'recovery':'notReplaced','logPath':str(folder/'update.log')}
        held=False; invoked=False
        try:
            manifest=release['manifest']; validate_manifest(manifest,manifest['version'],context.architecture,context.macos)
            if compare_versions(manifest['version'],context.installed_version)<=0 or release.get('notesURL')!='https://github.com/augustocbx/heed-macos/releases/tag/'+manifest['tag']:
                raise UpdateError('invalid-metadata','The pinned release is not a valid upgrade.')
            state.update(targetVersion=manifest['version'],targetCommit=manifest['commit']); save(context,state)
            def idle():
                status=deps.activity(context)
                if status.get('maintenanceProtocol')!=2 or not isinstance(status.get('processingKinds'),list):
                    raise UpdateError('unsupported-maintenance','Migrate the installed API before using menu updates.')
                if status.get('maintenance') and status.get('updateTransactionId')!=transaction:
                    raise UpdateError('maintenance-failed','Another maintenance owner is active.')
                return not status['processingKinds']
            if not idle(): return discard_payloads(context,save(context,{**state,'phase':'waitingForIdle','errorCode':'busy'}))
            for kind in ['installer','payload']:
                asset=manifest['assets'][kind]
                download_verified(asset,folder/asset['name'],deps.transport,
                                  progress=lambda done,total:save(context,{**state,'progress':{'asset':kind,'completed':done,'total':total}}))
            state.update(phase='verifying',progress=None); save(context,state)
            archive=folder/manifest['assets']['payload']['name']
            name=validate_archive(archive,manifest); payload=extract_payload(archive,folder,name)
            if not idle(): return discard_payloads(context,save(context,{**state,'phase':'waitingForIdle','errorCode':'busy'}))
            state.update(phase='installing',recovery='recoveryRequired'); save(context,state)
            held=True
            deps.maintenance(context,owner,transaction,True)
            invoked=True
            code=deps.installer(context,folder/manifest['assets']['installer']['name'],payload,lock,transaction,owner)
            state.update(phase='checkingServices',recovery='recoveryRequired'); save(context,state)
            return finish_verification(context,state,deps,code)
        except (OSError,ValueError,KeyError) as error:
            code=error.code if isinstance(error,UpdateError) else 'update-failed'
            phase='failed'
            if held and not invoked:
                try:
                    lease=deps.activity(context)
                    if (lease.get('maintenanceProtocol')==2 and type(lease.get('maintenance')) is bool
                        and isinstance(lease.get('processingKinds'),list)):
                        if lease.get('maintenance') and lease.get('updateTransactionId')==transaction:
                            deps.maintenance(context,owner,transaction,False); held=False
                        elif lease.get('maintenance') is False and lease.get('updateTransactionId') is None:
                            held=False
                            if lease['processingKinds']: phase='waitingForIdle'; code='busy'
                        elif lease.get('maintenance') and isinstance(lease.get('updateTransactionId'),str):
                            held=False  # Never release another transaction's lease.
                except (OSError,ValueError,KeyError): pass
            return discard_payloads(context,save(context,{**state,'phase':phase,'errorCode':code,'recovery':'recoveryRequired' if held else 'notReplaced'}))


def reconcile_transaction(context,dependencies=None):
    deps=dependencies or TransactionDependencies()
    with InstallationLock(context.home):
        state=current_state(context)
        if not state.get('transactionId'): return state
        if state.get('phase') in ['completed','waitingForIdle'] or state.get('recovery')=='notReplaced': return state
        result=update_state.read(context.home,state['transactionId'],'installer-result.json')
        try: return finish_verification(context,state,deps,result['exitCode'] if result else 1)
        except (OSError,ValueError,KeyError):
            return save(context,{**state,'phase':'failed','errorCode':'recovery-required','recovery':'recoveryRequired'})


def trusted_copy(context,folder):
    root=folder/'coordinator'; (root/'scripts/release').mkdir(parents=True,mode=0o700)
    (root/'config').mkdir(mode=0o700)
    for name in ['heed_release.py','installation_lock.py','release_updates.py','update_state.py','update_transaction.py']:
        shutil.copyfile(Path(__file__).with_name(name),root/'scripts/release'/name)
    resource_root=Path(__file__).resolve().parents[2]
    for name in ['service_config.py','service_runtime.py']:
        shutil.copyfile(resource_root/'scripts'/name,root/'scripts'/name)
    shutil.copyfile(resource_root/'config/service-ports.json',root/'config/service-ports.json')
    return root/'scripts/release/update_transaction.py'


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['check','install','worker','status','recover','permissions'])
    parser.add_argument('--root',required=True); parser.add_argument('--home',required=True)
    parser.add_argument('--app-dir',default=str(Path.home()/'.heed-app'))
    parser.add_argument('--version',required=True); parser.add_argument('--commit')
    parser.add_argument('--architecture',default='arm64'); parser.add_argument('--macos',required=True)
    parser.add_argument('--automatic',action='store_true')
    args=parser.parse_args(argv)
    context=UpdateContext(Path(args.root).resolve(),Path(args.home),Path(args.app_dir),args.version,args.commit,args.architecture,args.macos)
    try:
        if args.command=='status':
            state=current_state(context)
            if state.get('phase') in ACTIVE:
                try:
                    with InstallationLock(context.home):
                        state=current_state(context)
                        if state.get('phase') in ACTIVE:
                            state=save(context,{**state,'phase':'failed','errorCode':'interrupted','recovery':state.get('recovery','recoveryRequired')})
                except ValueError: pass
        elif args.command=='check':
            with InstallationLock(context.home):
                state=current_state(context)
                if state.get('phase') in ACTIVE or state.get('recovery')=='recoveryRequired':
                    raise UpdateError('recovery-required','Resolve the current update before checking another release.')
                if not args.automatic or time.time()-state.get('lastAutomaticAttempt',0)>=86400:
                    state=save(context,{**state,'state':'checking','phase':None,**({'lastAutomaticAttempt':time.time()} if args.automatic else {})})
                    result=check_release(context.installed_version,context.architecture,context.macos)
                    state=save(context,{**state,**result})
        elif args.command=='install':
            with InstallationLock(context.home) as lock:
                state=current_state(context)
                if state.get('state')!='available' or not state.get('release') or state.get('recovery')=='recoveryRequired':
                    raise UpdateError('recovery-required','Check for an available release or resolve recovery first.')
                transaction=str(uuid.uuid4()); folder=update_state.directory(context.home,transaction)
                helper=trusted_copy(context,folder)
                state=save(context,{**state,'transactionId':transaction,'owner':str(uuid.uuid4()),'phase':'downloading',
                                    'targetVersion':state['release']['manifest']['version'],'targetCommit':state['release']['manifest']['commit'],
                                    'installedRoot':str(context.root),'installedVersion':context.installed_version,'installedCommit':context.installed_commit,
                                    'recovery':'notReplaced','errorCode':None,'permissionState':'unknown','logPath':str(folder/'update.log'),
                                    'progress':None,'missingPermissions':[],'optionalAccess':[],
                                    'verifiedVersion':None,'verifiedCommit':None,'permissionVersion':None,'cleanupWarning':None})
                command=[sys.executable,str(helper),'worker',*sys.argv[2:]] if argv is None else [sys.executable,str(helper),'worker',*argv[1:]]
                log=os.open(folder/'coordinator.log',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
                try:
                    subprocess.Popen(command,env={**os.environ,'HEED_INSTALL_LOCK_FD':str(lock.fd)},pass_fds=(lock.fd,),
                                     start_new_session=True,stdin=subprocess.DEVNULL,stdout=log,stderr=log)
                finally: os.close(log)
        elif args.command=='worker':
            state=current_state(context)
            state=run_update(context,state['release'],transaction=state['transactionId'],inherited_fd=int(os.environ['HEED_INSTALL_LOCK_FD']))
        elif args.command=='recover': state=reconcile_transaction(context)
        else:
            with InstallationLock(context.home):
                state=current_state(context)
                if state.get('permissionVersion')!=context.installed_version or state.get('phase') in ACTIVE: raise UpdateError('recovery-required','Verify the installation before checking permissions.')
                retained=verified_context(context,state)
                if not services(retained,state['verifiedVersion'],state['verifiedCommit']): raise UpdateError('unverified-service','Verify the installed services first.')
                state=save(context,{**state,**permission_outcome(permissions(retained),state['verifiedVersion'],state['verifiedCommit'])})
        print(json.dumps(state)); return 0
    except (OSError,ValueError,KeyError) as error:
        print(json.dumps({'schema':1,'state':'checkFailed','phase':'failed','errorCode':error.code if isinstance(error,UpdateError) else 'update-failed',
                          'detail':str(error),'installedVersion':context.installed_version,'permissionState':'unknown'})); return 1


if __name__=='__main__': sys.exit(main())
