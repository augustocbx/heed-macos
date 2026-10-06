import {test,expect} from 'bun:test';
import {ServiceDiagnostics} from './service-diagnostics';

const ports={api:48100,ui:48101,transcription:48102};
const statuses=Object.entries(ports).map(([service,port])=>({service,port,state:'conflict',application:'Ruby'}));

test('diagnostics share a brief cache and explicit recheck observes recovery',async()=>{
 let calls=0;let result:unknown=statuses;let now=0;
 const diagnostics=new ServiceDiagnostics({root:'/synthetic',ports,env:{},now:()=>now,run:async()=>{calls++;return result;}});
 const [first,second]=await Promise.all([diagnostics.get(),diagnostics.get()]);
 expect(first).toEqual(statuses);expect(second).toEqual(statuses);expect(calls).toBe(1);
 result=Object.entries(ports).map(([service,port])=>({service,port,state:'stopped'}));expect(await diagnostics.get()).toEqual(statuses);
 expect(await diagnostics.get(true)).toEqual(result);expect(calls).toBe(2);
 now=6000;await diagnostics.get();expect(calls).toBe(3);
});

test('invalid or private process output becomes unavailable without exposing raw data',async()=>{
 for(const result of [[{...statuses[0],cwd:'/private/secret',command:'ruby --password=secret'}],statuses.map(item=>({...item,application:'/private/user/Ruby'})),statuses.map(item=>({...item,application:'Ruby\n'})),statuses.map(item=>({...item,port:5002})),null]){
  const diagnostics=new ServiceDiagnostics({root:'/synthetic',ports,env:{},run:async()=>result});
  const safe=await diagnostics.get();expect(safe).toEqual(Object.entries(ports).map(([service,port])=>({service,port,state:'unavailable'})));
  expect(JSON.stringify(safe)).not.toContain('secret');expect(JSON.stringify(safe)).not.toContain('/private');
 }
});
