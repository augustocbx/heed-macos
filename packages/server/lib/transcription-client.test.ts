import {afterAll, describe, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecordingCoordinator} from './recording-coordinator';
import type {Session} from '@heed/shared';
import {pyPost as post, pyGet as get} from './transcription-client';

let handler: (request: Request) => Response | Promise<Response> = () => new Response('{}');
const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>handler(request)});
// Exercise real loopback I/O without changing process environment or the shared module's URL.
const fixtureFetch: typeof fetch = (input,init) => fetch(`http://127.0.0.1:${server.port}${new URL(String(input)).pathname}`,init);
const pyGet: typeof get = (path,options={}) => get(path,{...options,fetch:fixtureFetch});
const pyPost: typeof post = (path,body,options={}) => post(path,body,{...options,fetch:fixtureFetch});
afterAll(()=>server.stop(true));
async function bounded(promise: Promise<unknown>) {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve('deadline escaped'),500);})]); }
 finally {clearTimeout(timer);}
}

describe('bounded transcription HTTP requests',()=>{
  test('a sidecar that never sends headers does not strand stop finalization',async()=>{
    handler=()=>new Promise(()=>{});
    expect(await bounded(pyPost('/stream/finish',{}, {timeoutMs:40}))).toBeNull();
  });
  test('deadline includes an incomplete JSON response body',async()=>{
    handler=()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}));
    expect(await bounded(pyPost('/finalize',{}, {timeoutMs:40}))).toBeNull();
  });
  test('caller abort ends only its HTTP request',async()=>{
    handler=()=>new Promise(()=>{});
    const controller=new AbortController();
    const request=pyPost('/diar/finish',{}, {timeoutMs:300,signal:controller.signal});
    controller.abort();
    expect(await bounded(request)).toBeNull();
    handler=()=>Response.json({ok:true});
    expect(await pyPost('/stream/start',{}, {timeoutMs:300})).toEqual({ok:true});
  });
  test('a delayed valid finalize response stays inside its explicit budget',async()=>{
    handler=async()=>{await Bun.sleep(70);return Response.json({ok:true,turns:[]});};
    expect(await pyPost('/finalize',{}, {timeoutMs:300})).toEqual({ok:true,turns:[]});
  });
  test('GET health still fetches and validates the sidecar identity',async()=>{
    const health={service:'heed-transcription',protocolVersion:1,checkoutRoot:'/synthetic-checkout',pid:123,whisper:true,pyannote:false,ready:true};
    handler=()=>Response.json(health);
    expect(await pyGet('/health')).toEqual(health);
    handler=()=>Response.json({...health,service:'foreign-service'});
    expect(await pyGet('/health')).toBeNull();
  });
  test('GET health headers cannot strand desktop status',async()=>{
    handler=()=>new Promise(()=>{});
    expect(await bounded(pyGet('/health',{timeoutMs:40}))).toBeNull();
  });
  test('GET health incomplete JSON body cannot strand desktop status',async()=>{
    handler=()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}));
    expect(await bounded(pyGet('/health',{timeoutMs:40}))).toBeNull();
  });
  test('physical capture stops first and timed-out finalization preserves durable failure and WAV',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'heed-timeout-'));
    const wav=join(directory,'synthetic.wav');
    const audio=Buffer.from('524946462800000057415645666d74201000000001000100803e0000007d000002001000646174610400000000000000','hex');
    writeFileSync(wav,audio);
    let stopped=false;
    handler=()=>{expect(stopped).toBe(true);return new Promise(()=>{});};
    const adapter={
      start:async (_mode:unknown,_id:unknown,attach:(path:string)=>void)=>{attach(wav);return {path:wav};},
      stop:async (physicalStopped:()=>void)=>{stopped=true;physicalStopped();const result=await pyPost('/finalize',{}, {timeoutMs:40});if(!result)throw new Error('Final transcription unavailable');throw new Error('Unexpected response');},
      finalize:async()=>({path:wav,duration:1,language:'en',model:'synthetic',turns:[{speaker:'Speaker 1',text:'Synthetic.',start:0,end:1}]}),
      save:(session:Partial<Session>)=>({...session,id:session.id!} as Session),
    };
    try {
      const manifestPath=join(directory,'recording.json');
      const coordinator=new RecordingCoordinator({manifestPath,adapter});
      const active=await coordinator.start('start','both');
      const result=await bounded(coordinator.stop('stop',active.meetingId!).catch(error=>error));
      expect(result).toBeInstanceOf(Error);
      expect(coordinator.snapshot().state).toBe('failed');
      expect(coordinator.snapshot().path).toBe(wav);
      expect(readFileSync(wav)).toEqual(audio);
      const restarted=new RecordingCoordinator({manifestPath,adapter});
      expect(restarted.snapshot().state).toBe('failed');
      expect(restarted.snapshot().path).toBe(wav);
      expect((await restarted.retry('retry',active.meetingId!)).state).toBe('completed');
      expect(readFileSync(wav)).toEqual(audio);
    } finally {server.stop(true);await Bun.sleep(10);rmSync(directory,{recursive:true,force:true});}
  });
});
