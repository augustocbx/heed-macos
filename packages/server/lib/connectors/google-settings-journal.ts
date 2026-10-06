import {existsSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {atomicWriteJson} from '../atomic-json';
import {readPrivateJson} from './private-json';
import {validGoogleSelectionCheckpoint,type GoogleSelectionCheckpoint} from './google-auth';
import {validGoogleProtectionCheckpoint,type GoogleProtectionCheckpoint} from './google-source-protection';
export interface GoogleSettingsIntent {action:'connect'|'disconnect'|'select'|'create'|'enable';selection:GoogleSelectionCheckpoint;protection:GoogleProtectionCheckpoint|null;preferredId:string|null;currentId:string|null}
interface State {version:1;intent:GoogleSettingsIntent|null}
const providerId=(id:unknown)=>id===null||typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
function validIntent(value:unknown):value is GoogleSettingsIntent {
 const v=value as GoogleSettingsIntent;
 return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')==='action,currentId,preferredId,protection,selection'&&['connect','disconnect','select','create','enable'].includes(v.action)&&validGoogleSelectionCheckpoint(v.selection)&&(v.protection===null||validGoogleProtectionCheckpoint(v.protection))&&providerId(v.preferredId)&&providerId(v.currentId);
}
/** Unfinished settings changes preserve device-private recovery state, never token or upload URL payloads. */
export class GoogleSettingsJournal {
 private state:State;
 constructor(private path:string,private write=atomicWriteJson){mkdirSync(dirname(path),{recursive:true,mode:0o700});this.state=existsSync(path)?readPrivateJson<State>(path,16777216):{version:1,intent:null};if(!this.state||Object.keys(this.state).sort().join(',')!=='intent,version'||this.state.version!==1||(this.state.intent!==null&&!validIntent(this.state.intent)))throw new Error('Invalid Google settings intent; preserve it for recovery');}
 intent():GoogleSettingsIntent|null{return this.state.intent?structuredClone(this.state.intent):null;}
 private persist(intent:GoogleSettingsIntent|null){if(intent&&!validIntent(intent))throw new Error('Invalid Google settings intent');const next={version:1 as const,intent};if(Buffer.byteLength(JSON.stringify(next))>16777216)throw new Error('Google settings recovery limit reached');this.write(this.path,next);this.state=next;}
 begin(intent:GoogleSettingsIntent){if(this.state.intent)throw new Error('Google settings recovery is required');this.persist(structuredClone(intent));}
 clear(){this.persist(null);}
}
