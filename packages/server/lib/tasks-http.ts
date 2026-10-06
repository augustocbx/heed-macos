import type { AcceptTaskInput, TaskPatch } from '../../shared/types';
import type { MeetingTasksService } from './meeting-tasks';
import { desktopRequestAllowed } from './desktop-permissions';
function string(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=200;}
export async function tasksResponse(request:Request,service:MeetingTasksService,port:number|string):Promise<Response>{
 if(!desktopRequestAllowed(request,port))return new Response(null,{status:403});
 const url=new URL(request.url);
 try{
  if(request.method==='GET')return Response.json(service.snapshot(url.searchParams.get('sessionId')||undefined));
  if(request.method!=='POST')return new Response(null,{status:405});
  if(Number(request.headers.get('content-length'))>2_000_000)throw new Error('Invalid task request');
  const input=await request.text();if(input.length>2_000_000)throw new Error('Invalid task request');
  let body:any;try{body=JSON.parse(input);}catch{throw new Error('Invalid task request');}
  if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Invalid task request');
  if(body.action==='accept'||body.action==='dismiss'){
   if(!string(body.sessionId)||!string(body.sourceRevision))throw new Error('Invalid task request');
   return Response.json(body.action==='accept'?service.accept(body.sessionId,body.sourceRevision,body.items as AcceptTaskInput[]):service.dismiss(body.sessionId,body.sourceRevision,body.ids));
  }
  if(body.action==='retry'){
   if(!string(body.sessionId))throw new Error('Invalid task request');service.retry(body.sessionId);return Response.json(service.snapshot(body.sessionId));
  }
  if(body.action==='update'||body.action==='delete'){
   if(!string(body.id)||!string(body.revision))throw new Error('Invalid task request');
   if(body.action==='update')service.update(body.id,body.revision,body.patch as TaskPatch);else service.delete(body.id,body.revision);
   return Response.json(service.snapshot());
  }
  throw new Error('Invalid task request');
 }catch(error){
  const message=(error as Error).message;const conflict=/changed|no longer available|Final transcript/.test(message);const missing=/not found/.test(message);const invalid=/^Invalid/.test(message);
  return Response.json({error:conflict||missing||invalid?message:'Could not save tasks. Please retry.'},{status:conflict?409:missing?404:invalid?400:503});
 }
}
