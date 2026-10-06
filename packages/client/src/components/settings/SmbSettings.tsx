import {useCallback,useEffect,useRef,useState} from 'react';import {smbApi,type SmbSnapshot,type SmbTest} from '@/api/smb';import {useLocale} from '@/lib/i18n';import styles from './PermissionsPage.module.css';
export function SmbSettings({onProviderChanged}:{onProviderChanged?:()=>void}={}){
 const {tr}=useLocale();const [recovery,setRecovery]=useState(false);const recoveryNotice='Synchronization settings recovery is required. Preserve configuration and pending copies.';const [snapshot,setSnapshot]=useState<SmbSnapshot|null>(null);const [name,setName]=useState('');const [folder,setFolder]=useState('');const [address,setAddress]=useState('');const [test,setTest]=useState<SmbTest|null>(null);const [create,setCreate]=useState(false);const [connectionId,setConnectionId]=useState<string|undefined>();const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const [edits,setEdits]=useState<Record<string,string>>({});const chosen=useRef<string|null>(null);const genericNotice='Could not complete the SMB operation. Check the mount, access, security and quota, then test again.';const unsupportedNotice='SMB filesystem does not support the required atomic operations. Use a compatible destination; existing files are preserved.';const originalNotice='Recover the original SMB operation before reconnecting or disconnecting this destination. Its configuration is preserved.';const failureNotice=(failure:unknown)=>failure instanceof Error&&[unsupportedNotice,originalNotice].includes(failure.message)?failure.message:genericNotice;
 const refresh=useCallback(async()=>{try{const next=await smbApi.status();if(!next||!Array.isArray(next.connections))throw new Error('Invalid synchronization status');setSnapshot(next);setRecovery(!!next.recoveryRequired);if(next.selectedFolder&&next.selectedFolder!==chosen.current){chosen.current=next.selectedFolder;setFolder(next.selectedFolder);setTest(null);setCreate(false);setConnectionId(undefined);}}catch(failure){if(failure instanceof Error&&failure.message===recoveryNotice)setRecovery(true);setError(failureNotice(failure));}},[]);
 useEffect(()=>{void refresh();const timer=window.setInterval(()=>void refresh(),3000);return()=>clearInterval(timer);},[refresh]);
 const run=async(action:()=>Promise<SmbSnapshot>)=>{setBusy(true);setError(null);try{const next=await action();setSnapshot(next);setRecovery(!!next.recoveryRequired);onProviderChanged?.();}catch(failure){if(failure instanceof Error&&failure.message===recoveryNotice)setRecovery(true);setError(failureNotice(failure));}finally{setBusy(false);}};
 const check=async(value=folder,id?:string)=>{setBusy(true);setError(null);setTest(null);setCreate(false);setConnectionId(id);try{setTest(await smbApi.test(value));}catch(failure){if(failure instanceof Error&&failure.message===recoveryNotice)setRecovery(true);setError(failureNotice(failure));}finally{setBusy(false);}};
 const connect=()=>run(async()=>{const next=await smbApi.connect(name,test!.receipt,create,connectionId);setTest(null);setCreate(false);return next;});
 const blocked=busy||recovery;
 return <article className={styles.card} aria-labelledby="smb-title">
  <h2 id="smb-title">{tr('Synchronization destinations')}</h2><h3>{tr('SMB/Samba')}</h3>
  <p>{tr('Mount and authenticate with macOS. Heed never stores your SMB password.')}</p>
  <p>{tr('One destination is enabled at a time on this Mac. Other connections keep their pending revisions.')}</p>
  <p>{tr('Imported transcripts stay available offline. Audio downloads only when requested. Disconnecting never deletes remote meetings.')}</p>
  {!snapshot&&!recovery&&<p role="status">{tr('Checking synchronization destinations…')}</p>}
  {(error||snapshot?.desktopError)&&<p role="alert">{tr(recovery?recoveryNotice:error||genericNotice)}</p>}
  <label htmlFor="smb-name">{tr('Destination name')}</label><input id="smb-name" value={name} maxLength={80} disabled={blocked} onChange={e=>setName(e.target.value)}/>
  <label htmlFor="smb-address">{tr('SMB server/share address')}</label><input id="smb-address" value={address} maxLength={2048} placeholder="smb://server/share" disabled={blocked} onChange={e=>setAddress(e.target.value)}/>
  <button disabled={blocked||!!snapshot?.desktopPending||!address} onClick={()=>void run(()=>smbApi.mount(address))}>{tr('Open macOS connection flow')}</button>
  <label htmlFor="smb-folder">{tr('Mounted share folder')}</label><input id="smb-folder" value={folder} maxLength={4096} disabled={blocked} onChange={e=>{setFolder(e.target.value);setTest(null);setCreate(false);setConnectionId(undefined);}}/>
  <button disabled={blocked||!!snapshot?.desktopPending} onClick={()=>void run(()=>smbApi.folder())}>{tr('Select mounted share folder')}</button>
  <button disabled={blocked||!folder} onClick={()=>void check()}>{tr('Test access')}</button>
  {snapshot?.desktopPending&&<p role="status">{tr('Complete the connection or folder selection in the Heed macOS window.')}</p>}
  {test&&<div role="status"><p>{tr(test.readOnly?'Read-only — imports available':'Read/write — publication available')}</p><p>{tr(test.security==='encrypted'?'SMB encryption required':'SMB signing active')} · {test.dialect}</p><p>{tr('Destination identity')}: {test.destinationId||tr('New library')}</p>
   {test.needsCreation&&<label><input type="checkbox" checked={create} disabled={blocked} onChange={e=>setCreate(e.target.checked)}/>{tr('Create a dedicated Heed Library subfolder')}</label>}
   <button disabled={blocked||!name.trim()||(test.needsCreation&&!create)} onClick={()=>void connect()}>{tr('Connect and synchronize')}</button>
  </div>}
  <p>{tr('Share acknowledgment does not prove survival of server power loss.')}</p>
  {snapshot?.syncing&&<p role="status">{tr('Synchronizing complete transcript revisions…')}</p>}
  {snapshot?.connections.map(c=><section key={c.id} aria-label={c.name}>
   <h4>{c.name}</h4><p>{c.root}</p><p>{tr('Destination identity')}: {c.destinationId}</p>
   <p>{tr(c.enabled?'Enabled':'Disabled')} · {tr(c.readOnly?'Read-only — imports available':'Read/write — publication available')} · {tr(c.security==='encrypted'?'SMB encryption required':c.security==='signed'?'SMB signing active':'Transport security not verified')}</p>
   <p>{tr('Imported: {imported}; skipped: {skipped}; queued: {pending}; discovered text bytes: {bytes}.',{imported:c.imported,skipped:c.skipped,pending:c.pending,bytes:c.bytes})}</p>
   {c.error&&<p role="alert">{tr([unsupportedNotice,originalNotice].includes(c.error)?c.error:'Some revisions remain pending. Test the mount and check available local storage before retrying.')}</p>}
   <label htmlFor={`smb-rename-${c.id}`}>{tr('Rename destination')}</label><input id={`smb-rename-${c.id}`} value={edits[c.id]??c.name} disabled={blocked} maxLength={80} onChange={e=>setEdits(prev=>({...prev,[c.id]:e.target.value}))}/>
   <button disabled={blocked||!(edits[c.id]??c.name).trim()} onClick={()=>void run(()=>smbApi.rename(c.id,edits[c.id]??c.name))}>{tr('Save name')}</button>
   <button disabled={blocked} onClick={()=>void run(()=>smbApi.enable(c.id,!c.enabled))}>{tr(c.enabled?'Disable':'Enable')}</button>
   <button disabled={blocked||snapshot.syncing} onClick={()=>{const parent=c.root.replace(/\/Heed Library$/,'');setName(c.name);setFolder(parent);void check(parent,c.id);}}>{tr('Test connection')}</button>
   <button disabled={blocked||!c.enabled||snapshot.syncing} onClick={()=>void run(()=>smbApi.sync(c.id))}>{tr('Synchronize now')}</button>
   <button disabled={blocked} onClick={()=>void run(()=>smbApi.disconnect(c.id))}>{tr('Disconnect destination')}</button>
  </section>)}
 </article>;
}
