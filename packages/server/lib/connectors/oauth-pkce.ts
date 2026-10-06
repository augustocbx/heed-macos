import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
export interface DesktopOAuthOptions {
 authorizationEndpoint:string;clientId:string;scopes:string[];parameters?:Record<string,string>;
 openBrowser:(url:string)=>Promise<void>;signal?:AbortSignal;timeoutMs?:number;
}
export interface DesktopOAuthCode {code:string;redirectUri:string;codeVerifier:string}
/** Each explicit authorization gets a separate loopback listener, state and PKCE verifier. */
export async function beginDesktopOAuth(options:DesktopOAuthOptions):Promise<DesktopOAuthCode>{
 const endpoint=new URL(options.authorizationEndpoint);const reserved=new Set(['client_id','redirect_uri','scope','state','response_type','code_challenge','code_challenge_method']);
 if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.hash||!options.clientId||options.clientId.length>1024||!options.scopes.length||options.scopes.some(s=>!s||/\s/.test(s))||Object.keys(options.parameters||{}).some(key=>reserved.has(key)))throw new Error('Invalid desktop authorization configuration');
 const timeout=options.timeoutMs??300000;if(!Number.isFinite(timeout)||timeout<1||timeout>600000)throw new Error('Invalid authorization timeout');
 if(options.signal?.aborted)throw new Error('Authorization cancelled');
 const state=randomBytes(32).toString('base64url'),codeVerifier=randomBytes(48).toString('base64url');
 let done=false;let resolveResult!:(result:DesktopOAuthCode)=>void,rejectResult!:(error:Error)=>void;
 const result=new Promise<DesktopOAuthCode>((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
 let timer:ReturnType<typeof setTimeout>|undefined;let redirectUri='';
 const finish=(value?:DesktopOAuthCode,error?:Error)=>{if(done)return;done=true;if(timer)clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);server.stop(false);if(error)rejectResult(error);else resolveResult(value!);};
 const cancel=()=>finish(undefined,new Error('Authorization cancelled'));
 const headers={'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
 const server=Bun.serve({hostname:'127.0.0.1',port:0,error(){return new Response('Invalid authorization callback',{status:400,headers});},fetch(request){
  const url=new URL(request.url);
  if(request.headers.has('origin'))return new Response('Invalid callback origin',{status:403,headers});
  if(request.method!=='GET')return new Response('Invalid callback method',{status:405,headers});
  if(done||url.origin!==new URL(redirectUri).origin||url.pathname!=='/oauth/callback'||request.headers.get('host')!==new URL(redirectUri).host)return new Response('Unknown callback',{status:404,headers});
  const received=url.searchParams.get('state')||'';
  if(url.searchParams.getAll('state').length!==1||Buffer.byteLength(received)!==Buffer.byteLength(state)||!timingSafeEqual(Buffer.from(received),Buffer.from(state)))return new Response('Invalid callback state',{status:400,headers});
  if(url.searchParams.has('error')){finish(undefined,new Error('Authorization was denied'));return new Response('Authorization was denied. Return to Heed.',{headers});}
  const code=url.searchParams.get('code');if(!code||code.length>8192||url.searchParams.getAll('code').length!==1)return new Response('Invalid authorization response',{status:400,headers});
  finish({code,redirectUri,codeVerifier});return new Response('Authorization received. Return to Heed.',{headers});
 }});
 redirectUri=`http://127.0.0.1:${server.port}/oauth/callback`;
 endpoint.searchParams.set('client_id',options.clientId);endpoint.searchParams.set('redirect_uri',redirectUri);endpoint.searchParams.set('scope',options.scopes.join(' '));endpoint.searchParams.set('response_type','code');endpoint.searchParams.set('state',state);endpoint.searchParams.set('code_challenge_method','S256');endpoint.searchParams.set('code_challenge',createHash('sha256').update(codeVerifier).digest('base64url'));
 for(const [key,value] of Object.entries(options.parameters||{}))endpoint.searchParams.set(key,value);
 options.signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(()=>finish(undefined,new Error('Authorization timed out')),timeout);
 if(options.signal?.aborted)cancel();
 if(!done)Promise.resolve().then(()=>options.openBrowser(endpoint.toString())).catch(()=>finish(undefined,new Error('Could not open the system browser')));
 return result;
}
