import {useEffect,useState} from 'react';
import type {OneDriveConnectionSnapshot,OneDriveLibraryChoice} from '@heed/shared';
import {oneDriveApi,oneDriveExpectation} from '@/api/onedrive';
import {useLocale} from '@/lib/i18n';
import styles from './PermissionsPage.module.css';
export function OneDriveSettings(){
 const {tr}=useLocale();
 const [snapshot,setSnapshot]=useState<OneDriveConnectionSnapshot|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[choices,setChoices]=useState<OneDriveLibraryChoice[]>([]),[folder,setFolder]=useState(''),[name,setName]=useState(''),[upload,setUpload]=useState(false),[clientId,setClientId]=useState(''),[tenant,setTenant]=useState('common');
 const apply=(value:OneDriveConnectionSnapshot)=>{setSnapshot(previous=>{if(!previous||previous.folderGeneration!==value.folderGeneration||previous.authGeneration!==value.authGeneration){setChoices([]);setFolder('');setUpload(value.uploadLocal);}return value;});};
 useEffect(()=>{let mounted=true;const load=()=>oneDriveApi.snapshot().then(value=>{if(mounted)apply(value);}).catch(()=>{if(mounted)setError('Could not load OneDrive settings.');});void load();const timer=setInterval(()=>void load(),3000);return()=>{mounted=false;clearInterval(timer);};},[]);
 const run=async(operation:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await operation();apply(await oneDriveApi.snapshot());}catch{setError('OneDrive operation failed. Refresh the settings and check account support and permissions.');try{apply(await oneDriveApi.snapshot());}catch{/* The last visible destination remains available for review. */}}finally{setBusy(false);}};
 const proof=()=>oneDriveExpectation(snapshot!);
 const blocked=busy||snapshot?.busy||snapshot?.authorizing;
 const choice=choices.find(value=>value.id===folder);
 return <article className={styles.card} aria-labelledby="onedrive-title"><h2 id="onedrive-title">Microsoft OneDrive</h2>
  <p>{tr('Choose a library inside the Heed app folder. Account support is checked before synchronization; broader permissions are never requested automatically.')}</p>
  <p>{tr('Remote audio downloads only when requested. Imported transcripts are available to local AI.')}</p>
  {error&&<p role="alert">{tr(error)}</p>}
  {!snapshot?<p>{tr('Loading OneDrive settings…')}</p>:<>
   <p role="status">{tr(snapshot.authorizing?'Waiting for Microsoft authorization…':snapshot.connected?'Microsoft account authorized.':'Microsoft authorization is required.')}</p>
   {snapshot.error&&<p role="status">{tr('Synchronization needs attention. Check account permissions, storage, and pending work.')}</p>}
   {!snapshot.connected&&!snapshot.authorizing&&<><label htmlFor="onedrive-client">{tr('Microsoft application client ID')}</label><input id="onedrive-client" value={clientId} disabled={blocked} onChange={event=>setClientId(event.target.value)} autoComplete="off"/><label htmlFor="onedrive-tenant">{tr('Microsoft account audience')}</label><select id="onedrive-tenant" value={tenant} disabled={blocked} onChange={event=>setTenant(event.target.value)}><option value="common">{tr('Personal or work account')}</option><option value="consumers">{tr('Personal account')}</option><option value="organizations">{tr('Work or school account')}</option></select><p>{tr('Register a public desktop application with http://localhost/oauth/callback. No client secret is needed.')}</p><button disabled={blocked||!clientId.trim()} onClick={()=>void run(()=>oneDriveApi.command('connect',proof(),{clientId:clientId.trim(),tenant}))}>{tr('Authorize Microsoft account')}</button></>}
   {snapshot.authorizing&&<button disabled={busy} onClick={()=>void run(()=>oneDriveApi.command('cancel',proof()))}>{tr('Cancel Microsoft authorization')}</button>}
   {snapshot.connected&&<>
    {snapshot.selected&&<p>{tr('Selected OneDrive library')}: {snapshot.selected.name}</p>}
    <button disabled={blocked} onClick={()=>void run(async()=>{setChoices(await oneDriveApi.libraries(proof()));})}>{tr('Browse app-folder libraries')}</button>
    {!!choices.length&&<><label htmlFor="onedrive-folder">{tr('OneDrive library')}</label><select id="onedrive-folder" value={folder} disabled={blocked} onChange={event=>setFolder(event.target.value)}><option value="">{tr('Choose a OneDrive library')}</option>{choices.map(value=><option key={value.id} value={value.id}>{value.name}{value.needsCreation?` (${tr('Empty folder initialization required')})`:''}</option>)}</select>
     {choice?.needsCreation&&<button disabled={blocked} onClick={()=>void run(async()=>{const value=await oneDriveApi.initialize(proof(),folder);setChoices(previous=>previous.map(item=>item.id===value.id?value:item));})}>{tr('Initialize empty OneDrive folder')}</button>}
     <button disabled={blocked||!choice||choice.needsCreation} onClick={()=>void run(()=>oneDriveApi.command('select',proof(),{folderId:folder,uploadLocal:upload}))}>{tr('Use selected OneDrive library')}</button></>}
    <label htmlFor="onedrive-create">{tr('New OneDrive library name')}</label><input id="onedrive-create" value={name} disabled={blocked} onChange={event=>setName(event.target.value)} maxLength={100}/><button disabled={blocked||!name.trim()} onClick={()=>void run(async()=>{const value=await oneDriveApi.create(proof(),name.trim());setChoices(previous=>[...previous.filter(item=>item.id!==value.id),value]);setFolder(value.id);setName('');})}>{tr('Create OneDrive library')}</button>
    <label><input type="checkbox" checked={upload} disabled={blocked} onChange={event=>setUpload(event.target.checked)}/>{tr('Upload local meetings to this library')}</label>
    {snapshot.selected&&<><button disabled={blocked} onClick={()=>void run(()=>oneDriveApi.command('configure',proof(),{enabled:!snapshot.enabled,uploadLocal:upload}))}>{tr(snapshot.enabled?'Pause OneDrive synchronization':'Enable OneDrive synchronization')}</button><button disabled={blocked||!snapshot.enabled} onClick={()=>void run(()=>oneDriveApi.command('sync',proof()))}>{tr('Synchronize OneDrive now')}</button><button disabled={blocked} onClick={()=>void run(()=>oneDriveApi.command('configure',proof(),{enabled:snapshot.enabled,uploadLocal:upload}))}>{tr('Save OneDrive upload preference')}</button></>}
    <p>{tr('Pending')}: {snapshot.pending} · {tr('Imported')}: {snapshot.imported} · {tr('Skipped')}: {snapshot.skipped}</p>
    <p>{snapshot.remoteCapacity?tr('OneDrive remote space: {remaining} GB available of {total} GB. The local storage limit is separate.',{remaining:(snapshot.remoteCapacity.remaining/1e9).toFixed(2),total:(snapshot.remoteCapacity.total/1e9).toFixed(2)}):tr('Remote capacity is unavailable. The local storage limit is separate.')}</p>
    <p>{tr('Disconnect removes credentials from this Mac and stops synchronization. Local transcripts and remote copies are preserved. Revoke Microsoft consent separately in your account settings.')}</p>
    <button disabled={busy} onClick={()=>void run(()=>oneDriveApi.command('disconnect',proof()))}>{tr('Disconnect OneDrive')}</button>
   </>}
  </>}
 </article>;
}
