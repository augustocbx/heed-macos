import defaults from '../../../config/service-ports.json';
export function servicePort(value:string|number,label:string):number {
 const raw=String(value);
 if(!/^[0-9]+$/.test(raw))throw Error(`${label} must be a decimal TCP port.`);
 const port=Number(raw);
 if(!Number.isSafeInteger(port)||port<1||port>65535||defaults.forbiddenRanges.some(([first,last])=>port>=first!&&port<=last!))throw Error(`${label} must be 1–65535 outside 3000–3999, 5000–5999, 7000–7999 and 8000–8999.`);
 return port;
}
export function serviceConfig(env:Record<string,string|undefined>) {
 if(env.HEED_API_PORT!==undefined&&env.PORT!==undefined&&servicePort(env.HEED_API_PORT,'HEED_API_PORT')!==servicePort(env.PORT,'PORT'))throw Error('HEED_API_PORT and PORT disagree.');
 const ports={api:servicePort(env.HEED_API_PORT??env.PORT??defaults.api,'API port'),ui:servicePort(env.HEED_UI_PORT??defaults.ui,'Interface port'),transcription:servicePort(env.HEED_TRANSCRIPTION_PORT??defaults.transcription,'Transcription port')};
 if(new Set(Object.values(ports)).size!==3)throw Error('Heed service ports must be distinct.');
 return ports;
}
export function localServiceUrl(value:string,label='Heed service'):string {
 const url=new URL(value);
 if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error(`${label} must be a loopback origin without credentials, paths or queries.`);
 servicePort(url.port|| (url.protocol==='https:'?'443':'80'),`${label} port`);
 return url.origin;
}
