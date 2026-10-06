import type {ServiceDiagnostic} from '@heed/shared';
import {useHealthStore} from '@/stores/health';
import {tr,useLocale} from '@/lib/i18n';
import styles from './ServiceNotices.module.css';
const serviceNames={api:'Heed API',ui:'Heed interface',transcription:'Transcription engine'};
const messages={
 conflict:'Another application is using {service} port {port}.',
 stopped:'{service} is stopped on port {port}.',
 starting:'{service} is starting on port {port}.',
 unhealthy:'{service} is not healthy on port {port}.',
 unavailable:'Could not diagnose {service} on port {port}.',
};
export function ServiceNotice({notice}:{notice:ServiceDiagnostic}){
 useLocale();const check=useHealthStore(state=>state.check);
 if(notice.state==='ready')return null;
 const application=notice.state==='conflict'&&notice.application&&/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(notice.application)?notice.application:undefined;
 return <section className={styles.notice} role="status">
  <strong>{tr(messages[notice.state],undefined,{service:tr(serviceNames[notice.service]),port:notice.port})}</strong>
  {application&&<p>{tr('Application: {application}',undefined,{application})}</p>}
  {notice.state==='conflict'?<p>{tr('Heed preserved the other application. Stop it yourself, or choose a free allowed Heed port and restart Heed.')}</p>:notice.state!=='starting'&&<p>{tr('Retry Heed startup after checking the service and its configured port.')}</p>}
  {notice.state==='conflict'&&<p>{tr('Change the service port in service-ports.json, or use its HEED_API_PORT, HEED_UI_PORT or HEED_TRANSCRIPTION_PORT startup setting. Ports 3000–3999, 5000–5999, 7000–7999 and 8000–8999 are unavailable.')}</p>}
  {notice.state==='conflict'&&<p>{tr('Installed app and LaunchAgent port settings must match. If they still use the old ports, rerun the installer while idle with matching settings.')}</p>}
  <button type="button" onClick={()=>void check(true)}>{tr('Check again')}</button>
 </section>;
}
export function ServiceDiagnosisUnavailable(){useLocale();const check=useHealthStore(state=>state.check);return <section role="status" className={styles.notice}><strong>{tr('Could not diagnose Heed services.')}</strong><p>{tr('Service checks are unavailable. Heed has not verified service status. Check again before troubleshooting.')}</p><button type="button" onClick={()=>void check(true)}>{tr('Check again')}</button></section>;}
export function ServiceNotices(){const services=useHealthStore(state=>state.health.services),unavailable=useHealthStore(state=>state.diagnosticsUnavailable);return <>{unavailable&&!services&&<ServiceDiagnosisUnavailable/>}{services?.filter(item=>item.state!=='ready').map(item=><ServiceNotice key={item.service} notice={item}/>)}</>;}
