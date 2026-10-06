import {useState} from 'react';
import {useLocale} from '@/lib/i18n';
import {SmbSettings} from './SmbSettings';
import {ICloudFolderSettings} from './ICloudFolderSettings';
import styles from './PermissionsPage.module.css';

type RemoteStorageProvider = '' | 'smb' | 'icloud';

export function RemoteStorageSettings({onProviderChanged}: {onProviderChanged?: () => void} = {}) {
 const {tr} = useLocale();
 const [provider, setProvider] = useState<RemoteStorageProvider>('');

 return <section className={styles.remoteStorage} aria-labelledby="remote-storage-title">
  <article className={`${styles.card} ${styles.providerChoice}`}>
   <h2 id="remote-storage-title">{tr('Remote storage')}</h2>
   <p id="remote-storage-description">{tr('Choose a provider to view its settings. Your existing connections keep their current configuration.')}</p>
   <label htmlFor="remote-storage-provider">{tr('Remote storage provider')}</label>
   <select id="remote-storage-provider" value={provider} aria-describedby="remote-storage-description" onChange={event => setProvider(event.target.value as RemoteStorageProvider)}>
    <option value="">{tr('Choose remote storage')}</option>
    <option value="smb">{tr('SMB/Samba')}</option>
    <option value="icloud">iCloud Drive</option>
   </select>
  </article>
  {provider === 'smb' && <SmbSettings onProviderChanged={onProviderChanged}/>}
  {provider === 'icloud' && <ICloudFolderSettings onProviderChanged={onProviderChanged}/>}
 </section>;
}
