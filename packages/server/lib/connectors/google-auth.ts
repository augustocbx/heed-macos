import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {atomicWriteJson} from '../atomic-json';
import {beginDesktopOAuth,type DesktopOAuthOptions} from './oauth-pkce';
import type {SecretVault} from './keychain-vault';
export const GOOGLE_SCOPES={
 'app-files':'https://www.googleapis.com/auth/drive.file',
 'existing-readonly':'https://www.googleapis.com/auth/drive.readonly',
 'existing-readwrite':'https://www.googleapis.com/auth/drive',
} as const;
import type {GoogleAccessMode,GoogleFolder,GoogleConnectionSnapshot} from '@heed/shared';
export type {GoogleAccessMode,GoogleFolder,GoogleConnectionSnapshot} from '@heed/shared';
interface State {version:1;generation:number;connectionId?:string;clientId?:string;accessMode?:GoogleAccessMode;credentialRef?:string;requiresAuthorization?:boolean;folder?:GoogleFolder}
interface Tokens {accessToken:string;refreshToken:string;expiresAt:number;scopes:string[]}
interface Options {path:string;vault:SecretVault;openBrowser:(url:string)=>Promise<void>;oauth?:typeof beginDesktopOAuth;fetch?:(input:string|URL,init?:RequestInit)=>Promise<Response>;now?:()=>number;write?:typeof atomicWriteJson}
export class GoogleConnectionError extends Error {
 constructor(readonly code:string,message:string){super(message);}
}
export async function readGoogleJson(response:Response,maxBytes=131072):Promise<Record<string,unknown>>{
 if(!response.body)throw new GoogleConnectionError('provider-response','Invalid Google response');
 const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
 try{while(true){const result=await reader.read();if(result.done)break;bytes+=result.value.length;if(bytes>maxBytes)throw new Error();chunks.push(result.value);}const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}
 catch{await reader.cancel().catch(()=>{});throw new GoogleConnectionError('provider-response','Invalid Google response');}
 finally{reader.releaseLock();}
}
/** Device-specific state contains public IDs and opaque references, never credential payloads. */
export class GoogleAuth {
 private state:State;private active?:AbortController;private job?:Promise<void>;private error?:string;private refresh?:Promise<Tokens>;
 constructor(private options:Options){
  mkdirSync(dirname(options.path),{recursive:true,mode:0o700});
  this.state=existsSync(options.path)?JSON.parse(readFileSync(options.path,'utf8')):{version:1,generation:0};
  if(this.state.version!==1||!Number.isSafeInteger(this.state.generation)||this.state.generation<0||(this.state.accessMode&&!Object.hasOwn(GOOGLE_SCOPES,this.state.accessMode)))throw new Error('Invalid Google connection state; preserve it for recovery');
 }
 private now(){return (this.options.now||Date.now)();}
 private persist(next:State){(this.options.write||atomicWriteJson)(this.options.path,next);this.state=next;}
 snapshot():GoogleConnectionSnapshot{return {connected:!!this.state.credentialRef&&!this.state.requiresAuthorization,authorizing:!!this.active,connectionId:this.state.connectionId,clientId:this.state.clientId,accessMode:this.state.accessMode,folder:this.state.folder?structuredClone(this.state.folder):undefined,generation:this.state.generation,error:this.error};}
 start(input:{clientId:string;accessMode:GoogleAccessMode;broaderAccessConfirmed?:boolean}):GoogleConnectionSnapshot{
  if(this.active)throw new Error('Authorization is already running');
  if(typeof input.clientId!=='string'||!/^[-A-Za-z0-9_]+\.apps\.googleusercontent\.com$/.test(input.clientId)||input.clientId.length>256||!Object.hasOwn(GOOGLE_SCOPES,input.accessMode))throw new Error('Invalid Google desktop client configuration');
  if(input.accessMode!=='app-files'&&input.broaderAccessConfirmed!==true)throw new Error('Explicit consent is required for broader Drive access');
  const controller=new AbortController();this.active=controller;this.error=undefined;
  this.job=this.authorize(input,controller).catch(error=>{this.error=controller.signal.aborted?'authorization-cancelled':error instanceof GoogleConnectionError?error.code:'authorization-failed';}).finally(()=>{if(this.active===controller)this.active=undefined;});
  return this.snapshot();
 }
 private async authorize(input:{clientId:string;accessMode:GoogleAccessMode},controller:AbortController){
  const old=this.state.credentialRef;let newReference:string|undefined;
  try{
   const code=await (this.options.oauth||beginDesktopOAuth)({authorizationEndpoint:'https://accounts.google.com/o/oauth2/v2/auth',clientId:input.clientId,scopes:[GOOGLE_SCOPES[input.accessMode]],parameters:{access_type:'offline',prompt:'consent'},openBrowser:this.options.openBrowser,signal:controller.signal} satisfies DesktopOAuthOptions);
   controller.signal.throwIfAborted();
   const raw=await this.tokenRequest({client_id:input.clientId,code:code.code,code_verifier:code.codeVerifier,redirect_uri:code.redirectUri,grant_type:'authorization_code'},controller.signal);
   const tokens=this.parseTokens(raw,input.accessMode);controller.signal.throwIfAborted();newReference=await this.options.vault.put(tokens);controller.signal.throwIfAborted();
   this.persist({version:1,generation:this.state.generation+1,connectionId:randomUUID(),clientId:input.clientId,accessMode:input.accessMode,credentialRef:newReference});
  }finally{if(newReference&&this.state.credentialRef!==newReference)await this.options.vault.remove(newReference).catch(()=>{});}
  if(old&&old!==newReference)await this.options.vault.remove(old).catch(()=>{});
 }
 async wait():Promise<void>{await this.job;}
 async cancel():Promise<GoogleConnectionSnapshot>{this.active?.abort();await this.job;return this.snapshot();}
 private async tokenRequest(fields:Record<string,string>,signal?:AbortSignal){
  let response:Response;
  try{response=await (this.options.fetch||fetch)('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams(fields),headers:{'Content-Type':'application/x-www-form-urlencoded'},redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])])});}
  catch{throw new GoogleConnectionError('offline','Google Drive is unavailable');}
  const raw=await readGoogleJson(response);
  if(!response.ok){if(raw.error==='invalid_grant')throw new GoogleConnectionError('auth-required','Authorization is required');throw new GoogleConnectionError('authorization-failed','Google authorization failed');}return raw;
 }
 private parseTokens(raw:Record<string,unknown>,mode:GoogleAccessMode,previous?:Tokens):Tokens{
  const access=raw.access_token,refresh=raw.refresh_token??previous?.refreshToken,expires=raw.expires_in;
  const scopes=typeof raw.scope==='string'?raw.scope.split(/\s+/).filter(Boolean):previous?.scopes;
  if(!scopes?.includes(GOOGLE_SCOPES[mode]))throw new GoogleConnectionError('missing-scopes','Required Drive permission was not granted');
  if(typeof access!=='string'||!access||access.length>16384||typeof refresh!=='string'||!refresh||refresh.length>16384||typeof expires!=='number'||!Number.isFinite(expires)||expires<1||expires>86400||typeof raw.token_type!=='string'||raw.token_type.toLowerCase()!=='bearer')throw new GoogleConnectionError('provider-response','Invalid Google token response');
  return {accessToken:access,refreshToken:refresh,expiresAt:this.now()+expires*1000,scopes};
 }
 private async tokens(force=false,signal?:AbortSignal):Promise<Tokens>{
  if(this.active||!this.state.credentialRef||this.state.requiresAuthorization||!this.state.clientId||!this.state.accessMode)throw new GoogleConnectionError('auth-required','Authorization is required');
  const reference=this.state.credentialRef,generation=this.state.generation;
  const current=await this.options.vault.get<Tokens>(reference);
  if(!current||typeof current.refreshToken!=='string'||!current.refreshToken||!Array.isArray(current.scopes)||!current.scopes.includes(GOOGLE_SCOPES[this.state.accessMode]))throw new GoogleConnectionError('auth-required','Authorization is required');
  if(!force&&typeof current.accessToken==='string'&&current.expiresAt>this.now()+60000)return current;
  if(!this.refresh){const mode=this.state.accessMode,clientId=this.state.clientId;
   this.refresh=(async()=>{try{
    const raw=await this.tokenRequest({client_id:clientId,refresh_token:current.refreshToken,grant_type:'refresh_token'},signal);const next=this.parseTokens(raw,mode,current);
    if(this.state.generation!==generation||this.state.credentialRef!==reference)throw new GoogleConnectionError('connection-changed','Google connection changed');
    await this.options.vault.put(next,reference);return next;
   }catch(error){if(error instanceof GoogleConnectionError&&error.code==='auth-required'&&this.state.generation===generation){this.persist({...this.state,requiresAuthorization:true});this.error=error.code;}throw error;}finally{this.refresh=undefined;}})();
  }return this.refresh;
 }
 async accessToken(signal?:AbortSignal):Promise<string>{return (await this.tokens(false,signal)).accessToken;}
 async request(url:string,init:RequestInit={},signal?:AbortSignal):Promise<Response>{
  const target=new URL(url);
  if(target.protocol!=='https:'||target.hostname!=='www.googleapis.com'||target.port||target.username||target.password||target.hash||!(/^\/(drive\/v3|upload\/drive\/v3)\//.test(target.pathname)))throw new Error('Invalid Google API destination');
  const generation=this.state.generation;
  for(let attempt=0;attempt<2;attempt++){
   const token=await this.tokens(attempt>0,signal);if(this.state.generation!==generation)throw new GoogleConnectionError('connection-changed','Google connection changed');const headers=new Headers(init.headers);headers.set('Authorization',`Bearer ${token.accessToken}`);
   let response:Response;try{response=await (this.options.fetch||fetch)(target,{...init,headers,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(60000),...(signal?[signal]:[])])});}catch{throw new GoogleConnectionError('offline','Google Drive is unavailable');}
   if(this.state.generation!==generation){await response.body?.cancel();throw new GoogleConnectionError('connection-changed','Google connection changed');}
   if(response.status!==401||attempt===1)return response;await response.body?.cancel();
  }throw new GoogleConnectionError('auth-required','Authorization is required');
 }
 selectFolder(folder:GoogleFolder):void{
  if(!this.snapshot().connected||this.active)throw new GoogleConnectionError('auth-required','Authorization is required');
  this.persist({...this.state,generation:this.state.generation+1,folder:structuredClone(folder)});
 }
 async disconnect(revoke=false):Promise<GoogleConnectionSnapshot>{
  await this.cancel();await this.refresh?.catch(()=>{});const reference=this.state.credentialRef;let failure:string|undefined;
  if(revoke&&reference){try{const tokens=await this.options.vault.get<Tokens>(reference);if(tokens){const response=await (this.options.fetch||fetch)('https://oauth2.googleapis.com/revoke',{method:'POST',body:new URLSearchParams({token:tokens.refreshToken}),headers:{'Content-Type':'application/x-www-form-urlencoded'},redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)failure='revocation-failed';await response.body?.cancel();}}catch{failure='revocation-failed';}}
  this.persist({version:1,generation:this.state.generation+1,connectionId:this.state.connectionId,clientId:this.state.clientId,accessMode:this.state.accessMode});
  if(reference)try{await this.options.vault.remove(reference);}catch{failure=failure||'storage-unavailable';}this.error=failure;return this.snapshot();
 }
}
