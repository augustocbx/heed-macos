import {randomUUID} from 'node:crypto';
import {chmodSync, lstatSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import type {AiCapabilities, AiConnectionInput, AiConnectionSnapshot, AiFeature, AiProviderId, AiSelection, AiSettingsSnapshot} from '../../../shared/types/ai';
import {localServiceUrl} from '../../../shared/lib/service-config';
import {atomicWriteJson} from '../atomic-json';
import type {SecretVault} from '../connectors/keychain-vault';
import {readPrivateJson} from '../connectors/private-json';
import {AiInferenceError} from './contracts';
import {AI_ENDPOINTS, requestJson, validateRemoteEndpoint} from './transport';
import {MODEL_METADATA_VERIFIED_AT, modelCapabilities} from './model-metadata';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_CONFIGURATION_BYTES=1_000_000;
const features:AiFeature[]=['notes','tasks','chat','library-chat'];
const providers:Exclude<AiProviderId,'ollama'>[]=['openai','anthropic','deepseek','xai','compatible'];
const validationEndpoints={openai:'https://api.openai.com/v1/models',anthropic:'https://api.anthropic.com/v1/models',deepseek:'https://api.deepseek.com/models',xai:'https://api.x.ai/v1/models'};
export type AiConnectionErrorCode='invalid-request'|'invalid-endpoint'|'not-found'|'settings-recovery'|'credential-unavailable'|'connection-unvalidated'|'unsupported-capability'|'stale-connection';
export class AiConnectionError extends Error {
 constructor(readonly code:AiConnectionErrorCode){super(code);this.name='AiConnectionError';}
}
function reject(code:AiConnectionErrorCode):never {throw new AiConnectionError(code);}
function object(value:unknown):value is Record<string,any>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function positive(value:unknown):value is number {return Number.isSafeInteger(value)&&Number(value)>0;}
function exact(value:Record<string,any>, fields:string[]):boolean{return Object.keys(value).every(key=>fields.includes(key));}
function model(value:unknown):value is string {return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);}
function validKey(value:unknown):value is string {return typeof value==='string'&&value.length>0&&value.length<=8192&&value.trim()===value&&!/[\x00-\x20\x7f]/.test(value);}
function capabilities(value:unknown):AiCapabilities {
 if(!object(value)||!exact(value,['features','structuredOutput','streaming','contextTokens','maxOutputTokens','usageCategories','billableOutputBound','maxBillableOutputTokens'])||!Array.isArray(value.features)||!value.features.length||value.features.some((feature:unknown)=>!features.includes(feature as AiFeature))||new Set(value.features).size!==value.features.length||!['schema','validated-json','none'].includes(value.structuredOutput)||value.streaming!==false||!positive(value.contextTokens)||!positive(value.maxOutputTokens)||value.maxOutputTokens>value.contextTokens||!Array.isArray(value.usageCategories)||value.usageCategories.some((category:unknown)=>!['inputTokens','cachedInputTokens','cacheWriteTokens','outputTokens','reasoningTokens'].includes(String(category)))||new Set(value.usageCategories).size!==value.usageCategories.length||!['max-output','model-limit','unknown'].includes(value.billableOutputBound)||value.billableOutputBound==='model-limit'&&!positive(value.maxBillableOutputTokens)||value.maxBillableOutputTokens!==undefined&&!positive(value.maxBillableOutputTokens))return reject('unsupported-capability');
 return structuredClone(value) as AiCapabilities;
}
interface PrivateConnection extends AiConnectionSnapshot {credentialReference:string;}
interface Configuration {schema:1;version:number;selections:Record<AiFeature,AiSelection>;connections:PrivateConnection[];pendingCleanup:string[];}
interface PendingStore {connection:PrivateConnection;previousReference?:string;}
/** Server-only proof; it deliberately carries no Keychain reference. */
export interface AiConnectionCheckpoint {settingsVersion:number;connectionId:string|null;connectionGeneration:number;credentialGeneration:number;trustVersion:number;}
export interface ResolvedAiConnection {selection:AiSelection;endpoint:string;key?:string;capabilities?:AiCapabilities;checkpoint:AiConnectionCheckpoint;}
export interface AiConnectionsOptions {appDir:string;vault:SecretVault;fetch?:typeof fetch;localEndpoint?:string;}
function defaults():Configuration {return {schema:1,version:1,selections:Object.fromEntries(features.map(feature=>[feature,{provider:'ollama',connectionId:null,model:null}])) as Configuration['selections'],connections:[],pendingCleanup:[]};}
function selection(value:unknown):AiSelection {
 if(!object(value)||!exact(value,['provider','connectionId','model'])||!['ollama',...providers].includes(value.provider)||!(value.model===null||model(value.model))||!(value.connectionId===null||typeof value.connectionId==='string'&&UUID.test(value.connectionId))||value.provider==='ollama'&&value.connectionId!==null||value.provider!=='ollama'&&(value.connectionId===null||value.model===null))return reject('invalid-request');
 return {provider:value.provider,connectionId:value.connectionId,model:value.model};
}

/** A private device-local store. Its write-ahead cleanup references cover crashes
 * before/after Keychain writes; no secret payload enters this file or its journal.
 */
export class AiConnections {
 private state:Configuration=defaults();private failed=false;
 private readonly path:string;private readonly localEndpoint:string;
 private mutation:Promise<unknown>=Promise.resolve();private listeners=new Set<()=>void>();
 private pendingStore?:PendingStore;
 constructor(private readonly options:AiConnectionsOptions){
  this.path=join(options.appDir,'ai','connections.json');this.localEndpoint=localServiceUrl(options.localEndpoint??AI_ENDPOINTS.ollama,'Local Ollama');
  try{
   const directory=join(options.appDir,'ai');mkdirSync(directory,{recursive:true,mode:0o700});if(lstatSync(directory).isSymbolicLink())throw Error();chmodSync(directory,0o700);
   const stat=lstatSync(this.path,{throwIfNoEntry:false});
   if(stat){if(!stat.isFile())throw Error();const value=readPrivateJson(this.path,MAX_CONFIGURATION_BYTES);this.checkConfiguration(value);this.ensureWritable(value);this.state=value;chmodSync(this.path,0o600);}
  }catch{this.failed=true;}
 }
 private checkConfiguration(value:any):asserts value is Configuration {
  if(!object(value)||!exact(value,['schema','version','selections','connections','pendingCleanup'])||value.schema!==1||!positive(value.version)||!object(value.selections)||Object.keys(value.selections).sort().join(',')!==[...features].sort().join(',')||!Array.isArray(value.connections)||value.connections.length>100||!Array.isArray(value.pendingCleanup)||value.pendingCleanup.length>1000||value.pendingCleanup.some((ref:unknown)=>typeof ref!=='string'||!UUID.test(ref)))throw Error();
  for(const item of Object.values(value.selections))selection(item);
  const ids=new Set<string>(),refs=new Set<string>();
  for(const c of value.connections){
   if(!object(c)||!exact(c,['id','provider','model','endpoint','validationEndpoint','connectionGeneration','credentialGeneration','trustVersion','validation','validationCode','capabilities','capabilitySource','capabilityVerifiedAt','credentialReference'])||!UUID.test(c.id)||!UUID.test(c.credentialReference)||ids.has(c.id)||refs.has(c.credentialReference)||!providers.includes(c.provider)||!model(c.model)||![c.connectionGeneration,c.credentialGeneration,c.trustVersion].every(positive)||!['unvalidated','validated','failed','credential-unavailable'].includes(c.validation)||c.validationCode!==undefined&&!['credential-unavailable','authentication-failed','rate-limited','provider-unavailable','provider-timeout','request-rejected','invalid-endpoint','invalid-output','response-too-large','cancelled'].includes(c.validationCode))throw Error();
   ids.add(c.id);refs.add(c.credentialReference);validateRemoteEndpoint(c.endpoint,c.provider);
   if(c.provider==='compatible'){validateRemoteEndpoint(c.validationEndpoint);if(new URL(c.endpoint).origin!==new URL(c.validationEndpoint).origin||c.capabilitySource!=='explicit-declaration'||c.capabilityVerifiedAt!==null)throw Error();capabilities(c.capabilities);}
   else {if(c.endpoint!==AI_ENDPOINTS[c.provider as AiProviderId]||c.validationEndpoint!==validationEndpoints[c.provider as keyof typeof validationEndpoints])throw Error();const known=modelCapabilities(c.provider,c.model);if(JSON.stringify(c.capabilities)!==JSON.stringify(known)||c.capabilitySource!==(known?'verified-metadata':'unverified')||c.capabilityVerifiedAt!==(known?MODEL_METADATA_VERIFIED_AT:null))throw Error();}
  }
  if(value.pendingCleanup.some((ref:string)=>refs.has(ref)))throw Error();
  // A selected connection can be removed/reconfigured. Preserve that explicit
  // selection as unavailable until the user separately chooses another one.
 }
 private available(){if(this.failed)reject('settings-recovery');}
 private ensureWritable(next:Configuration):void {
  // Match atomicWriteJson's actual UTF-8 pretty JSON, including journal references.
  if(Buffer.byteLength(JSON.stringify(next,null,2),'utf8')>MAX_CONFIGURATION_BYTES)reject('invalid-request');
  try{this.checkConfiguration(next);}catch{reject('invalid-request');}
 }
 private committed(base:Configuration,pending:PendingStore):Configuration {
  const connection=pending.connection;
  return {...base,version:base.version+1,
   connections:[...base.connections.filter(c=>c.id!==connection.id),connection],
   pendingCleanup:[...base.pendingCleanup.filter(ref=>ref!==connection.credentialReference),...(pending.previousReference?[pending.previousReference]:[])],
  };
 }
 private write(next:Configuration){
  this.ensureWritable(next);
  // Selection changes remain synchronous during vault.put, but must also fit the
  // eventual commit. Reject them before writing or invalidating any checkpoint.
  if(this.pendingStore)this.ensureWritable(this.committed(next,this.pendingStore));
  try{atomicWriteJson(this.path,next);this.state=next;}
  catch{this.failed=true;this.changed();reject('settings-recovery');}
 }
 private serial<T>(operation:()=>Promise<T>):Promise<T>{const work=this.mutation.then(()=>{this.available();return operation();});this.mutation=work.catch(()=>{});return work;}
 private changed(){for(const listener of this.listeners)try{listener();}catch{/* An observer cannot undo durable invalidation. */}}
 subscribe(listener:()=>void):()=>void {this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private publicConnection(connection:PrivateConnection):AiConnectionSnapshot {
  const {credentialReference,...safe}=connection;
  // Failure is durable even when capacity cannot retain optional reason detail.
  // Derive this disclosure without spending bytes in the private record.
  if((safe.validation==='failed'||safe.validation==='credential-unavailable')&&!safe.validationCode)safe.validationCode='validation-details-unavailable';
  return safe;
 }
 snapshot():AiSettingsSnapshot {return structuredClone({version:this.state.version,selections:this.state.selections,connections:this.state.connections.map(connection=>this.publicConnection(connection)),pendingCleanup:this.state.pendingCleanup.length>0,unavailable:this.failed});}
 saveSelection(feature:AiFeature,input:AiSelection):AiSettingsSnapshot {
  this.available();if(!features.includes(feature))reject('invalid-request');const chosen=selection(input);
  if(chosen.provider!=='ollama'){const c=this.find(chosen.connectionId!);if(c.provider!==chosen.provider||c.model!==chosen.model)reject('invalid-request');}
  if(JSON.stringify(chosen)===JSON.stringify(this.state.selections[feature]))return this.snapshot();
  this.write({...this.state,version:this.state.version+1,selections:{...this.state.selections,[feature]:chosen}});this.changed();return this.snapshot();
 }
 private find(id:string):PrivateConnection {this.available();if(typeof id!=='string'||!UUID.test(id))return reject('invalid-request');const c=this.state.connections.find(item=>item.id===id);return c??reject('not-found');}
 private prepare(input:AiConnectionInput):Omit<PrivateConnection,'id'|'credentialReference'|'connectionGeneration'|'credentialGeneration'|'trustVersion'> {
  if(!object(input)||!exact(input,['provider','model','key','endpoint','validationEndpoint','trusted','capabilities'])||!providers.includes(input.provider)||!model(input.model)||!validKey(input.key)||input.model.includes(input.key))reject('invalid-request');
  let endpoint:string,validationEndpoint:string,caps:AiCapabilities|null;
  if(input.provider==='compatible'){
   if(input.trusted!==true||typeof input.endpoint!=='string'||typeof input.validationEndpoint!=='string'||input.endpoint.includes(input.key)||input.validationEndpoint.includes(input.key))reject('invalid-endpoint');
   endpoint=validateRemoteEndpoint(input.endpoint);validationEndpoint=validateRemoteEndpoint(input.validationEndpoint);
   // Canonical URLs are the exact destinations displayed in the accepted snapshot.
   if(endpoint!==input.endpoint||validationEndpoint!==input.validationEndpoint||new URL(endpoint).origin!==new URL(validationEndpoint).origin)reject('invalid-endpoint');caps=capabilities(input.capabilities);
  }else {if(['endpoint','validationEndpoint','trusted','capabilities'].some(field=>Object.hasOwn(input,field)))reject('invalid-request');endpoint=AI_ENDPOINTS[input.provider];validationEndpoint=validationEndpoints[input.provider];caps=modelCapabilities(input.provider,input.model);}
  return {provider:input.provider,model:input.model,endpoint,validationEndpoint,validation:'unvalidated',capabilities:caps,capabilitySource:input.provider==='compatible'?'explicit-declaration':caps?'verified-metadata':'unverified',capabilityVerifiedAt:input.provider==='compatible'||!caps?null:MODEL_METADATA_VERIFIED_AT};
 }
 register(input:AiConnectionInput):Promise<AiConnectionSnapshot>{return this.store(undefined,input);}
 replace(id:string,input:AiConnectionInput):Promise<AiConnectionSnapshot>{return this.store(id,input);}
 private store(id:string|undefined,input:AiConnectionInput):Promise<AiConnectionSnapshot>{
  // Clone before any asynchronous boundary; the caller cannot mutate accepted trust.
  let accepted:ReturnType<AiConnections['prepare']>;let key:string;try{accepted=this.prepare(input);key=input.key;}catch(error){return Promise.reject(error instanceof AiConnectionError?error:new AiConnectionError('invalid-endpoint'));}
  return this.serial(async()=>{
   const previous=id?this.find(id):undefined;if(!previous&&this.state.connections.length>=100)reject('invalid-request');const reference=randomUUID();
   const next:PrivateConnection={...accepted,id:previous?.id??randomUUID(),credentialReference:reference,connectionGeneration:(previous?.connectionGeneration??0)+1,credentialGeneration:(previous?.credentialGeneration??0)+1,trustVersion:(previous?.trustVersion??0)+1};
   const pending:PendingStore={connection:next,...(previous?{previousReference:previous.credentialReference}:{})};
   const preflight=()=>{
    const journal={...this.state,pendingCleanup:[...this.state.pendingCleanup,reference]};
    this.ensureWritable(journal);this.ensureWritable(this.committed(journal,pending));return journal;
   };
   // Check both crash-recovery and committed states before any vault side effect.
   preflight();await this.cleanup();const journal=preflight();
   this.pendingStore=pending;
   try{
    this.write(journal);
    try{const stored=await this.options.vault.put(key,reference);if(stored!==reference)throw Error();}
    catch{this.pendingStore=undefined;await this.cleanup();return reject('credential-unavailable');}
    const committed=this.committed(this.state,pending);this.pendingStore=undefined;
    this.write(committed);this.changed();await this.cleanup();return this.safe(next.id);
   }finally{this.pendingStore=undefined;}
  });
 }
 private safe(id:string):AiConnectionSnapshot {return structuredClone(this.publicConnection(this.find(id)));}
 /** May be retried after unlocking Keychain. Failure preserves pending references. */
 recover():Promise<void>{return this.serial(()=>this.cleanup());}
 private async cleanup():Promise<void>{for(const reference of [...this.state.pendingCleanup]){try{await this.options.vault.remove(reference);}catch{continue;}this.write({...this.state,pendingCleanup:this.state.pendingCleanup.filter(ref=>ref!==reference)});}}
 remove(id:string):Promise<void>{return this.serial(async()=>{
  const c=this.find(id);
  this.write({...this.state,version:this.state.version+1,connections:this.state.connections.filter(c=>c.id!==id),pendingCleanup:[...this.state.pendingCleanup,c.credentialReference]});this.changed();await this.cleanup();
 });}
 private checkpoint(c?:PrivateConnection):AiConnectionCheckpoint {return {settingsVersion:this.state.version,connectionId:c?.id??null,connectionGeneration:c?.connectionGeneration??0,credentialGeneration:c?.credentialGeneration??0,trustVersion:c?.trustVersion??0};}
 private matches(proof:AiConnectionCheckpoint):boolean {if(this.failed||this.state.version!==proof.settingsVersion)return false;if(proof.connectionId===null)return proof.connectionGeneration===0&&proof.credentialGeneration===0&&proof.trustVersion===0;const c=this.state.connections.find(item=>item.id===proof.connectionId);return !!c&&c.connectionGeneration===proof.connectionGeneration&&c.credentialGeneration===proof.credentialGeneration&&c.trustVersion===proof.trustVersion;}
 assertCurrent(proof:AiConnectionCheckpoint):void {if(!this.matches(proof)||proof.connectionId!==null&&this.find(proof.connectionId).validation!=='validated')reject('stale-connection');}
 async validate(id:string):Promise<AiConnectionSnapshot>{
  const c=structuredClone(this.find(id)),proof=this.checkpoint(c);let code:string|undefined;let state:AiConnectionSnapshot['validation']='validated';
  try{let key:unknown;try{key=await this.options.vault.get(c.credentialReference);}catch{return await this.validationResult(id,proof,'credential-unavailable','credential-unavailable');}if(!validKey(key))return await this.validationResult(id,proof,'credential-unavailable','credential-unavailable');if(!this.matches(proof))reject('stale-connection');
   const headers:Record<string,string>=c.provider==='anthropic'?{'x-api-key':key,'anthropic-version':'2023-06-01'}:{authorization:`Bearer ${key}`};
   await requestJson({endpoint:c.validationEndpoint,headers,signal:new AbortController().signal,fetch:this.options.fetch,validation:true});
  }catch(error){if(error instanceof AiConnectionError)throw error;state='failed';code=error instanceof AiInferenceError?error.code:'provider-unavailable';}
  return this.validationResult(id,proof,state,code);
 }
 private validationResult(id:string,proof:AiConnectionCheckpoint,validation:AiConnectionSnapshot['validation'],validationCode?:string):Promise<AiConnectionSnapshot>{return this.serial(async()=>{
  if(!this.matches(proof))reject('stale-connection');
  const previous=this.find(id);
  const updated={...previous,validation,...(validationCode?{validationCode}:{})};
  if(!validationCode)delete updated.validationCode;
  const changed=previous.validation!==validation||previous.validationCode!==validationCode;
  let version=this.state.version+(changed?1:0);
  const persist=()=>this.write({...this.state,version,connections:this.state.connections.map(c=>c.id===id?updated:c)});
  try{persist();}
  catch(error){
   if(validation==='validated'||!(error instanceof AiConnectionError)||error.code!=='invalid-request')throw error;
   // Never apply ordinary capacity rejection to discovered credential revocation.
   // Keep the precise status first, sacrificing only optional error detail.
   delete updated.validationCode;
   version=Math.min(version,Number.MAX_SAFE_INTEGER);
   try{persist();}
   catch(error){
    if(!(error instanceof AiConnectionError)||error.code!=='invalid-request')throw error;
    // 'failed' is shorter than 'validated' and 'unvalidated'. Together with at
    // most one version digit of growth, it always fits a writable prior record.
    // Already failed states need no extra version to remain inadmissible.
    updated.validation='failed';
    version=Math.min(Number.MAX_SAFE_INTEGER,this.state.version+(previous.validation==='validated'?1:0));
    persist();
   }
  }
  if(previous.validation!==updated.validation||previous.validationCode!==updated.validationCode||proof.settingsVersion!==this.state.version)this.changed();
  return this.safe(id);
 });}
 async resolve(input:AiSelection):Promise<ResolvedAiConnection>{
  this.available();const chosen=selection(input);if(chosen.provider==='ollama')return {selection:chosen,endpoint:this.localEndpoint,checkpoint:this.checkpoint()};
  const c=structuredClone(this.find(chosen.connectionId!));if(c.provider!==chosen.provider||c.model!==chosen.model)reject('invalid-request');if(c.validation!=='validated')reject('connection-unvalidated');if(!c.capabilities)reject('unsupported-capability');const proof=this.checkpoint(c);
  let key:unknown;try{key=await this.options.vault.get(c.credentialReference);}catch{reject('credential-unavailable');}this.assertCurrent(proof);if(!validKey(key))reject('credential-unavailable');
  return {selection:chosen,endpoint:c.endpoint,key,capabilities:structuredClone(c.capabilities),checkpoint:proof};
 }
}
