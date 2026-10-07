import type {AiProviderId, AiResult} from '../../packages/shared/types/ai';
import {AiConnections} from '../../packages/server/lib/inference/connections';
import {AiPlanError, aiErrorCode, aiFingerprint} from '../../packages/server/lib/inference/planning';
import {createAiInference} from '../../packages/server/lib/inference/production';
import type {AiBudgetReview} from '../../packages/shared/types/ai-budget';
import {getAiAdapter} from '../../packages/server/lib/inference/adapters';
import type {AiCall} from '../../packages/server/lib/inference/contracts';
import {NotesGenerationError} from '../../packages/server/lib/ollama-notes';

type Language='en'|'pt';
export interface CheckerOptions {
 provider:AiProviderId;model:string;connectionId:string|null;language:Language;
 allowSyntheticRemote?:boolean;acceptedPayloadHash?:string;allowUnknownCost?:boolean;
}
interface CheckerPreview {
 provider:AiProviderId;model:string;feature:'notes';fixture:string;payloadHash:string;
 calls:AiCall[];excluded:string[];
 costPolicy:'device-local-budget-resource-staged'|'local-no-api-charge';costStatus:'unknown'|'not-applicable';costReview?:AiBudgetReview;
}
export interface CheckerReport {
 exitCode:0|1;transport:'not-started'|'completed'|'cancelled'|'truncated'|'rate-limited'|'failed';
 sourceGrounding:'not-checked'|'passed'|'failed';factualQuality:'not-reviewed';
 code?:string;preview?:CheckerPreview;
}
const providers:AiProviderId[]=['ollama','openai','anthropic','deepseek','xai','compatible'];
const fixtures=Object.freeze({
 en:Object.freeze({id:'synthetic-en',text:'Mira will check the sample report on Friday. The budget remains undecided.'}),
 pt:Object.freeze({id:'synthetic-pt',text:'Mira verificará o relatório de exemplo na sexta-feira. O orçamento permanece indefinido.'}),
});
const flags={'--provider':'provider','--model':'model','--connection':'connectionId','--language':'language','--accept-payload-hash':'acceptedPayloadHash','--allow-synthetic-remote':'allowSyntheticRemote','--allow-unknown-cost':'allowUnknownCost'} as const;
const allowedOptions=new Set<string>(Object.values(flags));
function validOptions(options:CheckerOptions):void {
 if(!options||Object.keys(options).some(key=>!allowedOptions.has(key))
  ||!providers.includes(options.provider)||!['en','pt'].includes(options.language)
  ||typeof options.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(options.model)
  ||options.provider==='ollama'&&options.connectionId!==null
  ||options.provider!=='ollama'&&(typeof options.connectionId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.connectionId))
  ||options.acceptedPayloadHash!==undefined&&!/^[a-f0-9]{64}$/.test(options.acceptedPayloadHash)
  ||options.allowSyntheticRemote!==undefined&&typeof options.allowSyntheticRemote!=='boolean'
  ||options.allowUnknownCost!==undefined&&typeof options.allowUnknownCost!=='boolean')throw new AiPlanError('invalid-arguments');
}
/** No prompts, paths, endpoints, keys, or admission overrides are accepted. */
export function readCheckerOptions(args:string[]):CheckerOptions {
 const parsed:Record<string,string|boolean|null>={},seen=new Set<string>();
 for(let i=0;i<args.length;i++){
  const flag=args[i] as keyof typeof flags,key=flags[flag];
  if(!Object.hasOwn(flags,flag)||seen.has(flag))throw new AiPlanError('invalid-arguments');seen.add(flag);
  if(key==='allowSyntheticRemote'||key==='allowUnknownCost')parsed[key]=true;
  else {const value=args[++i];if(!value||value.startsWith('--'))throw new AiPlanError('invalid-arguments');parsed[key]=value;}
 }
 if(parsed.connectionId==='local')parsed.connectionId=null;
 parsed.allowSyntheticRemote??=false;
 const result=parsed as unknown as CheckerOptions;validOptions(result);return result;
}
export function syntheticCall(language:Language):AiCall {
 if(!Object.hasOwn(fixtures,language))throw new AiPlanError('invalid-arguments');
 return {id:`synthetic-${language}-notes`,system:'Use only the supplied synthetic source. Return JSON with claims containing sourceId and exact quote. Do not infer approval of an undecided budget.',data:{language,sources:[fixtures[language]]},schema:{type:'object',additionalProperties:false,required:['claims'],properties:{claims:{type:'array',minItems:1,maxItems:4,items:{type:'object',additionalProperties:false,required:['sourceId','quote'],properties:{sourceId:{type:'string'},quote:{type:'string',minLength:1,maxLength:200}}}}}},contextTokens:8192,maxOutputTokens:256};
}
/** Only stable typed codes leave the checker. No provider bodies or output text. */
export function checkerOutcome(language:Language,outcome:unknown):CheckerReport {
 const report:CheckerReport={exitCode:1,transport:'not-started',sourceGrounding:'not-checked',factualQuality:'not-reviewed'};
 if(outcome&&typeof outcome==='object'&&'finish' in outcome&&outcome.finish==='completed'){
  report.transport='completed';let grounded=false;
  try{const claims=JSON.parse((outcome as AiResult).text).claims;grounded=Array.isArray(claims)&&claims.length>0&&claims.length<=4&&claims.every(claim=>claim.sourceId===fixtures[language].id&&typeof claim.quote==='string'&&claim.quote.trim().length>0&&fixtures[language].text.includes(claim.quote));}catch{/* A completed transport is not a source contract. */}
  report.sourceGrounding=grounded?'passed':'failed';report.exitCode=grounded?0:1;
  if(!grounded)report.code='source-grounding-failed';return report;
 }
 const code=aiErrorCode(outcome)??(outcome instanceof NotesGenerationError?({ 'context-limit':'incomplete-output','incomplete-output':'incomplete-output','generation-timeout':'provider-timeout' } as Record<string,string>)[outcome.reason]:undefined)??'check-failed';
 report.code=code;
 report.transport=code==='cancelled'?'cancelled':code==='incomplete-output'?'truncated':code==='rate-limited'?'rate-limited':['provider-timeout','provider-unavailable','authentication-failed','request-rejected','invalid-output','response-too-large'].includes(code)?'failed':'not-started';
 return report;
}
/** Shares production exact review and private spending policy. No resource or budget bypass. */
export async function runSyntheticCheck(options:CheckerOptions,connections:AiConnections,transport:{fetch?:typeof fetch;signal?:AbortSignal}={}):Promise<CheckerReport> {
 let preview:CheckerPreview|undefined,inference:ReturnType<typeof createAiInference>|undefined;
 const signal=transport.signal??new AbortController().signal;
 try{
  validOptions(options);const reviewed=structuredClone(options);
  const initial=connections.snapshot(),source=fixtures[reviewed.language],selection={provider:reviewed.provider,model:reviewed.model,connectionId:reviewed.connectionId};
  inference=createAiInference(connections,transport.fetch?input=>getAiAdapter(input.selection.provider).generate({...input,fetch:transport.fetch}):undefined);
  const {planner,authorizations,runtime}=inference;
  planner.register('notes',async()=>({feature:'notes',jobId:`qa-${source.id}`,selection,calls:[syntheticCall(reviewed.language)],sources:[{sessionId:source.id,sourceRevision:aiFingerprint(source),sourceVersion:1}],validate:()=>{if(connections.snapshot().version!==initial.version)throw new AiPlanError('settings-changed');},attach:()=>{},dispatched:()=>{}}));
  const plan=await planner.prepare({feature:'notes'}),scope=authorizations.preview(plan);
  preview={provider:reviewed.provider,model:reviewed.model,feature:'notes',fixture:source.id,payloadHash:scope.payloadHash,calls:scope.calls,excluded:scope.excluded,costPolicy:reviewed.provider==='ollama'?'local-no-api-charge':'device-local-budget-resource-staged',...(scope.costReview?{costReview:scope.costReview}:{}),costStatus:reviewed.provider==='ollama'?'not-applicable':'unknown'};
  if(reviewed.provider!=='ollama'&&!reviewed.allowSyntheticRemote)throw new AiPlanError('synthetic-remote-opt-in-required');
  if(!reviewed.acceptedPayloadHash)throw new AiPlanError('scope-review-required');
  if(reviewed.acceptedPayloadHash!==plan.payloadHash)throw new AiPlanError('payload-changed');
  if(reviewed.provider!=='ollama')authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:reviewed.acceptedPayloadHash,...(reviewed.allowUnknownCost?{allowUnknownCost:true}:{})});
  const results=await runtime.execute(plan,signal);
  if(results.length!==1)throw new AiPlanError('check-failed');
  return {...checkerOutcome(reviewed.language,results[0]),preview};
 }catch(error){return {...checkerOutcome(options?.language??'en',signal.aborted?new AiPlanError('cancelled'):error),...(preview?{preview}:{})};}
 finally{inference?.budget?.close();}
}
if(import.meta.main){
 let report:CheckerReport;
 try{
  const options=readCheckerOptions(process.argv.slice(2));
  const [{APP_DIR},{createKeychainVault}]=await Promise.all([import('../../packages/server/lib/app-config'),import('../../packages/server/lib/connectors/keychain-vault')]);
  const connections=new AiConnections({appDir:APP_DIR,vault:createKeychainVault()});
  const controller=new AbortController(),cancel=()=>controller.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{report=await runSyntheticCheck(options,connections,{signal:controller.signal});}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
 }catch(error){report=checkerOutcome('en',error);}
 console.log(JSON.stringify(report,null,2));process.exitCode=report.exitCode;
}
