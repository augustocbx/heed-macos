import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { MeetingDetectionController } from "../../server/lib/meeting-detection";
const script=readFileSync(new URL("./background.js",import.meta.url),"utf8");
function background(local:Record<string,any>,reports:any[]) {
 const session:Record<string,any>={};
 const area=(data:Record<string,any>)=>({get:async(key:string)=>({[key]:structuredClone(data[key])}),set:async(value:object)=>Object.assign(data,structuredClone(value))});
 const listeners:Record<string,Function>={};
 const chrome={storage:{local:area(local),session:area(session)},action:{setBadgeText:()=>{}},runtime:{connectNative:()=>({postMessage:(report:any)=>reports.push(structuredClone(report)),onDisconnect:{addListener:()=>{}},onMessage:{addListener:()=>{}}}),onMessage:{addListener:(listener:Function)=>{listeners.message=listener;}}},tabs:{onRemoved:{addListener:(listener:Function)=>{listeners.close=listener;}}}};
 const context=createContext({chrome,Date,Set,Promise,Number});runInContext(script,context);
 return {forward:async(observation:any)=>runInContext("forward",context)(1,observation,"doc"),close:async()=>{listeners.close(1);await runInContext("queue",context);},local};
}
test("actual background forwarding remains monotonic after browser restart with restored call identity",async()=>{
 const local:Record<string,any>={sequences:{"browser:stable":{sequence:1800,updatedAt:0}}},reports:any[]=[];
 const report={detectorId:"browser:stable",callId:"stable-call",state:"active",capability:"ready"};
 const first=background(local,reports);await first.forward(report);expect(reports.at(-1).sequence).toBe(1801);
 const controller=new MeetingDetectionController({recording:{snapshot:()=>({state:"idle",meetingId:null}),start:async()=>({state:"recording",meetingId:"automatic"}),stop:async()=>({state:"completed",meetingId:"automatic"})}});
 expect(controller.report(reports.at(-1))).toBe(true);
 const restarted=background(local,reports);await restarted.forward(report);expect(reports.at(-1).sequence).toBe(1802);expect(controller.report(reports.at(-1))).toBe(true);
 await restarted.close();expect(reports.at(-1)).toMatchObject({sequence:1803,state:"inactive",callId:null});expect(controller.report(reports.at(-1))).toBe(true);
});
test("closed-tab sequence metadata is bounded across many browser tabs",async()=>{
 const local:Record<string,any>={},reports:any[]=[];
 const worker=background(local,reports);
 for(let index=0;index<300;index++){await worker.forward({detectorId:`browser:tab-${index}`,callId:`call-${index}`,state:"active",capability:"ready"});await worker.close();}
 expect(Object.keys(local.sequences).length).toBeLessThanOrEqual(256);
});
