import type {MediaImportConfig} from '../../shared/types/media-import';
import {MediaImportController,MAX_IMPORT_FILE_BYTES} from './media-import';
/** Local uploads only. This route never accepts local paths or download URLs. */
export async function mediaImportResponse(req:Request,controller:MediaImportController,allowed:boolean):Promise<Response|null>{
 const path=new URL(req.url).pathname;if(path!=='/api/media/imports'&&!/^\/api\/media\/imports\/[0-9a-f-]+(?:\/command)?$/i.test(path))return null;
 if(!allowed)return new Response(null,{status:403});
 try{
  if(path==='/api/media/imports'){
   if(req.method==='GET')return Response.json(controller.snapshot());
   if(req.method!=='POST')return new Response(null,{status:405});
   const length=Number(req.headers.get('content-length'));if(Number.isFinite(length)&&length>MAX_IMPORT_FILE_BYTES+1_000_000)return Response.json({error:'Choose a media file smaller than 256 MB.'},{status:413});
   if(!req.headers.get('content-type')?.includes('multipart/form-data'))return Response.json({error:'Choose a local media file. URL imports are unavailable.'},{status:400});
   const requestId=req.headers.get('X-Heed-Import-Id')||'',declaredSize=Number(req.headers.get('X-Heed-Import-Size'));
   if(!Number.isSafeInteger(length)||length<=0||!Number.isSafeInteger(declaredSize)||declaredSize<=0||length>declaredSize+1_000_000)throw Error('Upload size is unavailable or exceeds its declared limit. Choose the file again.');
   const lease=controller.beginUpload(requestId,declaredSize);
   try {
    const form=await req.formData();req.signal.throwIfAborted();if(form.has('url')||form.has('input'))return Response.json({error:'Choose a local media file. URL imports are unavailable.'},{status:400});
    const file=form.get('file');if(!(file instanceof File)||file.size!==declaredSize||form.get('requestId')!==requestId)throw Error('The upload changed. Choose the original file again.');
    const job=await controller.submit(requestId,file,{model:form.get('model'),language:form.get('language'),meetingMode:form.get('meetingMode')} as MediaImportConfig,lease.token);
    if(req.signal.aborted)controller.cancel(job.id);
    return Response.json(job,{status:202});
   } finally {lease.release();}
  }
  const id=path.split('/')[4]!;
  if(req.method==='GET'&&!path.endsWith('/command'))return Response.json(controller.get(id));
  if(req.method==='POST'&&path.endsWith('/command')){const {action}=await req.json();if(!['cancel','retry','discard'].includes(action))throw Error('Choose cancel, retry or discard.');return Response.json(controller[action as 'cancel'|'retry'|'discard'](id));}
  return new Response(null,{status:405});
 }catch(error){const message=(error as Error).message||'Import failed.';return Response.json({error:message},{status:/not found/i.test(message)?404:/recording|transcription|already|quota|storage|copy|saved|cleanup|full/i.test(message)?409:400});}
}
