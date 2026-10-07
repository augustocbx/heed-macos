import {beforeEach, expect, it, vi} from 'vitest';
import {recordingApi} from './recording';

beforeEach(()=>vi.restoreAllMocks());
it('start transmits no language or preview override',async()=>{
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({success:true}));
 await recordingApi.start('mic','request-1');
 expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({mode:'mic',requestId:'request-1'});
});
it('final-only is an explicit persistent preference followed by authoritative admission',async()=>{
 const requests:Array<[string,unknown]>=[];
 vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
  requests.push([String(url),JSON.parse(init?.body as string)]);
  return Response.json(requests.length===1?{enabled:false,liveLanguage:'pt'}:{success:true,snapshot:{realTimeTranscription:true,liveSpeechLanguage:'en'}});
 });
 const result=await recordingApi.recordFinalOnly('both','request-2');
 expect(requests).toEqual([['/api/recording/settings',{enabled:false}],['/api/sysrecord/start',{mode:'both',requestId:'request-2'}]]);
 expect(result.snapshot?.realTimeTranscription).toBe(true); // A concurrent settings change wins at admission.
});
it('failed preference persistence prevents final-only start',async()=>{
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({error:'disk unavailable'},{status:503}));
 await expect(recordingApi.recordFinalOnly()).rejects.toThrow('disk unavailable');
 expect(fetch).toHaveBeenCalledTimes(1);
});
it('a failed start reports that the explicit off preference was already saved',async()=>{
 let calls=0;
 vi.spyOn(globalThis,'fetch').mockImplementation(async()=>++calls===1?Response.json({enabled:false,liveLanguage:'pt'}):Response.json({error:'permission denied'},{status:409}));
 await expect(recordingApi.recordFinalOnly()).rejects.toMatchObject({message:'permission denied',persistedOff:true});
});
it('preserves structured unsupported admission errors for an explicit fallback',async()=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({error:'unsupported',code:'live-language-unsupported'},{status:409}));
 await expect(recordingApi.start()).rejects.toMatchObject({status:409,code:'live-language-unsupported'});
});
