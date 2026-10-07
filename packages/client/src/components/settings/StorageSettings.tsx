import {useCallback,useEffect,useRef,useState} from 'react';
import type {StoragePreview,StorageUsage} from '@heed/shared';
import {storageApi} from '@/api/storage';
import {useLocale} from '@/lib/i18n';
import styles from './PermissionsPage.module.css';

export function StorageSettings(){
 const {locale,tr}=useLocale();const [usage,setUsage]=useState<StorageUsage|null>(null);
 const [value,setValue]=useState('2');const [preview,setPreview]=useState<StoragePreview|null>(null);
 const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const [saved,setSaved]=useState(false);
 const busyRef=useRef(false);
 const dirty=useRef(false),sequence=useRef(0),mounted=useRef(true);
 const gb=(bytes:number)=>new Intl.NumberFormat(locale,{maximumFractionDigits:9}).format(bytes/1_000_000_000);
 const refresh=useCallback(async()=>{
  if(busyRef.current)return;
  const request=++sequence.current;
  try{const next=await storageApi.status();if(!mounted.current || request!==sequence.current)return;setUsage(next);if(!dirty.current)setValue(String(next.limitBytes/1_000_000_000));}
  catch{if(mounted.current && request===sequence.current)setError('Could not check meeting storage.');}
 },[]);
 useEffect(()=>{mounted.current=true;void refresh();const timer=window.setInterval(()=>void refresh(),5000);return()=>{mounted.current=false;++sequence.current;clearInterval(timer);};},[refresh]);
 const review=async(reset=false)=>{
  const bytes=reset?2_000_000_000:Number(value)*1_000_000_000;
  if(!value.trim() || !Number.isSafeInteger(bytes) || bytes<1_048_576 || bytes>8_000_000_000_000){setError('Choose a storage limit between 0.001048576 and 8000 GB using whole bytes.');return;}
  ++sequence.current;busyRef.current=true;setBusy(true);setError(null);setSaved(false);
  try{const next=await storageApi.preview(bytes);if(mounted.current){setPreview(next);if(reset){dirty.current=true;setValue('2');}}}
  catch(error){if(mounted.current)setError((error as Error).message);}finally{busyRef.current=false;if(mounted.current)setBusy(false);}
 };
 const apply=async()=>{
  if(!preview)return;++sequence.current;busyRef.current=true;setBusy(true);setError(null);
  try{const next=await storageApi.apply(preview.requestedLimit,preview.token);if(mounted.current){setUsage(next);setValue(String(next.limitBytes/1_000_000_000));dirty.current=false;setPreview(null);setSaved(true);}}
  catch(error){if(mounted.current){setError((error as Error).message);setPreview(null);}}finally{busyRef.current=false;if(mounted.current)setBusy(false);}
 };
 return <article className={styles.card} aria-labelledby="meeting-storage-title">
  <h2 id="meeting-storage-title">{tr('Local meeting storage')}</h2>
  <p>{tr('This limit covers transcripts, notes, tasks, chat, media, indexes and transfer staging on this Mac. Models, logs and provider caches are excluded.')}</p>
  {usage && <dl>{[
   ['Configured maximum',usage.limitBytes],['Used',usage.usedBytes],['Reserved working space',usage.reservedBytes],['Protected data',usage.protectedBytes],['Reclaimable local media',usage.reclaimableMediaBytes ?? usage.reclaimableBytes],...(usage.reclaimableCacheBytes !== undefined ? [['Rebuildable local search data',usage.reclaimableCacheBytes]] : []),['Available budget',usage.availableBytes],
   ['Transcripts and metadata',usage.categories.text],['Media',usage.categories.media],['Indexes',usage.categories.indexes],['Transfer staging',usage.categories.staging],
  ].map(([label,bytes])=><div key={String(label)}><dt>{tr(String(label))}</dt><dd>{gb(Number(bytes))} GB</dd></div>)}</dl>}
  <label htmlFor="meeting-storage-limit">{tr('Maximum local meeting data (GB)')}</label>
  <input id="meeting-storage-limit" type="number" min="0.001048576" max="8000" step="any" value={value} disabled={busy || !usage || !!preview} onChange={event=>{dirty.current=true;setValue(event.target.value);setSaved(false);setError(null);}}/>
  <p>{tr('1 GB = 1,000,000,000 bytes. Transcripts and pending work are never deleted to lower this limit.')}</p>
  <button disabled={busy || !usage || !!preview} onClick={()=>void review()}>{tr('Review change')}</button>{' '}
  <button disabled={busy || !usage || !!preview} onClick={()=>void review(true)}>{tr('Reset to 2 GB')}</button>
  {preview && <section aria-labelledby="storage-review-title"><h3 id="storage-review-title">{tr('Review storage change')}</h3>
   <p>{tr('New maximum: {size} GB',{size:gb(preview.requestedLimit)})}</p>
   <p>{tr('{count} local media files will be removed. Remote copies and transcripts remain unchanged.',{count:preview.removals.length})}</p>
   {preview.derivedCache && preview.derivedCache.bytes>0 && <p>{tr('Local search data ({count} files, {size} GB) will be cleared and can be rebuilt when space is available. This cleanup keeps transcripts and audio.',{count:preview.derivedCache.files,size:gb(preview.derivedCache.bytes)})}</p>}
   {preview.removals.length>0 && <ul>{preview.removals.map(file=><li key={file.path}>{file.path.split('/').at(-1)} — {gb(file.bytes)} GB</li>)}</ul>}
   <p>{tr('Additional imports pause when protected data consumes the available budget.')}</p>
   <button disabled={busy} onClick={()=>void apply()}>{tr('Confirm storage change')}</button>{' '}<button disabled={busy} onClick={()=>setPreview(null)}>{tr('Cancel')}</button>
  </section>}
  {error && <p className={styles.error} role="alert">{tr(error)}</p>}{saved && <p role="status">{tr('Storage limit saved.')}</p>}
 </article>;
}
