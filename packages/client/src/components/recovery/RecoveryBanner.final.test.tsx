import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RecoveryBanner } from "./RecoveryBanner";
import { useRecordingStore } from "@/stores/recording";

const orphan = {path:"/recordings/capture.wav",created:"2026-10-05T10:00:00Z",duration_estimate_s:20,size_mb:1,is_dual:true};
const result = {success:true,finalized:true,text:"Bom dia",metadata:{language:"pt",model:"small"},speakers:["Ana"],segments:[{speaker:"Ana",text:"Bom dia",start:0,end:2,channel:"sys"}],files:{wav:orphan.path}};
beforeEach(() => { useRecordingStore.getState().reset(); });
afterEach(() => vi.unstubAllGlobals());

test("recovery saves only after the complete authoritative stream with the detected language", async () => {
 let patch: Record<string, unknown> | undefined;
 vi.stubGlobal("fetch", vi.fn(async (url:string, init?:RequestInit) => {
  if (url.includes("recovery/list")) return Response.json({recordings:[orphan]});
  if (url.includes("transcribe")) return new Response(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
  if (init?.method === "POST") { patch = JSON.parse(init.body as string); return Response.json({...patch,id:"saved"}); }
  return Response.json([]);
 }));
 render(<RecoveryBanner/>);
 fireEvent.click(await screen.findByRole("button",{name:"Recover"}));
 await waitFor(() => expect(patch).toMatchObject({transcriptFinalized:true,language:"pt",speakers:["Ana"]}));
});

test("a result followed by a final stream error does not create an automatic job", async () => {
 let saves = 0;
 vi.stubGlobal("fetch", vi.fn(async (url:string, init?:RequestInit) => {
  if (url.includes("recovery/list")) return Response.json({recordings:[orphan]});
  if (url.includes("transcribe")) return new Response(`event: result\ndata: ${JSON.stringify(result)}\n\nevent: error\ndata: {"message":"Final pass failed"}\n\n`);
  if (init?.method === "POST") saves++;
  return Response.json([]);
 }));
 render(<RecoveryBanner/>);
 fireEvent.click(await screen.findByRole("button",{name:"Recover"}));
 await waitFor(() => expect(screen.getByRole("button",{name:"Recover"})).toBeEnabled());
 expect(saves).toBe(0);
});

test('newly released recovery audio appears immediately and keeps archived manual speaker names',async()=>{
 let available=false;let saved:any;
 const archived={...orphan,recoveryMeetingId:'retained-meeting',speakerNames:{'Speaker 1':'Ana'},segments:[{speaker:'Speaker 1',channel:'sys',text:'Bom dia',start:0,end:2}]};
 const final={...result,speakers:['Speaker 2'],segments:[{speaker:'Speaker 2',channel:'sys',text:'Bom dia',start:0,end:2}],embeddings:{'Speaker 2':[1,2]}};
 vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
  if(url.includes('recovery/list'))return Response.json({recordings:available?[archived]:[]});
  if(url.includes('transcribe'))return new Response(`event: result\ndata: ${JSON.stringify(final)}\n\n`);
  if(init?.method==='POST'){saved=JSON.parse(String(init.body));return Response.json({...saved,id:saved.id});}return Response.json([]);
 }));
 render(<RecoveryBanner/>);await waitFor(()=>expect(fetch).toHaveBeenCalled());available=true;fireEvent(window,new Event('heed:recovery-refresh'));
 fireEvent.click(await screen.findByRole('button',{name:'Recover'}));await waitFor(()=>expect(saved).toMatchObject({id:'retained-meeting',speakers:['Ana'],segments:[{speaker:'Ana'}],embeddings:{Ana:[1,2]}}));
});
