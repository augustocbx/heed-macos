import {lstatSync} from 'node:fs';
import {join} from 'node:path';import {homedir} from 'node:os';
import {readPrivateJson} from './connectors/private-json';
import {serviceConfig} from '../../shared/lib/service-config';
/** Device-only ports contain no meeting/provider data and never enter a portable library. */
export function configuredServicePorts(env:Record<string,string|undefined>=process.env) {
 const path=join(env.HEED_APP_DIR||join(homedir(),'.heed-app'),'service-ports.json');
 let saved:Record<string,number>|undefined;
 try{
  const stat=lstatSync(path);if(!stat.isFile())throw Error();
  const data=readPrivateJson<any>(path,4096);
  if(!data||Object.keys(data).sort().join(',')!=='api,transcription,ui,version'||data.version!==1||!['api','ui','transcription'].every(key=>typeof data[key]==='number'&&Number.isSafeInteger(data[key])))throw Error();
  serviceConfig({HEED_API_PORT:String(data.api),HEED_UI_PORT:String(data.ui),HEED_TRANSCRIPTION_PORT:String(data.transcription)});
  saved=data;
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('Invalid device service ports. Preserve service-ports.json and repair its configuration before starting Heed.');}
 return serviceConfig({...env,HEED_API_PORT:env.HEED_API_PORT??(env.PORT!==undefined?undefined:saved?.api?.toString()),HEED_UI_PORT:env.HEED_UI_PORT??saved?.ui?.toString(),HEED_TRANSCRIPTION_PORT:env.HEED_TRANSCRIPTION_PORT??saved?.transcription?.toString()});
}
