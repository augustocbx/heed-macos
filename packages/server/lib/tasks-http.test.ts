import { expect,test } from 'bun:test';
import { tasksResponse } from './tasks-http';
import { generateTaskSuggestions } from './task-generation';
import type { Session } from '../../shared/types';
const session={id:'m',language:'pt',transcript:'Vou enviar o relatório.',speakers:['Ana'],segments:[{speaker:'Ana',text:'Vou enviar o relatório.',start:0,end:2}]} as Session;
test('task commands reject foreign origins and malformed requests before mutation',async()=>{
 let calls=0;const service={snapshot:()=>{calls++;return {tasks:[]};}} as never;
 expect((await tasksResponse(new Request('http://localhost:5001/api/tasks',{headers:{origin:'https://outside.example'}}),service,5001)).status).toBe(403);expect(calls).toBe(0);
 expect((await tasksResponse(new Request('http://localhost:5001/api/tasks',{method:'POST',body:'bad'}),service,5001)).status).toBe(400);
 expect((await tasksResponse(new Request('http://localhost:5001/api/tasks',{method:'POST',body:JSON.stringify({action:'accept'})}),service,5001)).status).toBe(400);
 expect((await tasksResponse(new Request('http://localhost:5001/api/tasks'),service,5001)).status).toBe(200);expect(calls).toBe(1);
});
test('task model prompt requests cited JSON, nullable dates, explicit/inferred actions in original meeting language',async()=>{
 let input:any;const fetch=async(url:string,init?:RequestInit)=>{
  if(url.endsWith('/api/tags'))return Response.json({models:[{name:'fixture:1b'}]});
  if(url.endsWith('/api/show'))return Response.json({details:{family:'fixture'}});
  input=JSON.parse(String(init?.body));return new Response('{"response":"{\\"suggestions\\":[]}","done":true}\n');
 };
 const result=await generateTaskSuggestions(session,new AbortController().signal,{baseUrl:'http://localhost:11434',model:'fixture:1b',fetch:fetch as typeof globalThis.fetch});
 expect(result).toBe('{"suggestions":[]}');expect(input.format).toBe('json');expect(input.system).toContain('inferred');expect(input.system).toContain('Never resolve relative dates');expect(input.system).toContain('Brazilian Portuguese');
 expect(JSON.parse(input.prompt).segments[0]).toMatchObject({speaker:'Ana',segmentIndex:0,text:'Vou enviar o relatório.'});
});
