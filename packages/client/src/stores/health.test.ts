import {afterEach,expect,test,vi} from 'vitest';
import {useHealthStore} from './health';
afterEach(()=>vi.unstubAllGlobals());
const diagnostics=[{service:'api',port:48100,state:'conflict',application:'Ruby'},{service:'ui',port:48101,state:'ready'},{service:'transcription',port:48102,state:'stopped'}];
test('independent diagnostics prevent requests to a foreign API and discard stale working profiles',async()=>{
 const request=vi.fn(async()=>Response.json(diagnostics));vi.stubGlobal('fetch',request);
 useHealthStore.setState({health:{ollama:true,whisper:true,pyannote:true,whisper_info:{device:'CPU'} as never}});
 await useHealthStore.getState().check(true);
 expect(request).toHaveBeenCalledTimes(1);expect(String(request.mock.calls[0])).toContain('/.well-known/heed-services?refresh=1');
 expect(useHealthStore.getState().health).toMatchObject({whisper:false,pyannote:false,services:diagnostics});expect(useHealthStore.getState().health.whisper_info==null).toBe(true);
});
test('an explicit recheck accepts recovered identity while generic HTML or private diagnostic JSON fail closed',async()=>{
 let recovered=false;
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.includes('heed-services')?Response.json(diagnostics.map(item=>({...item,state:recovered?'ready':item.state,...(recovered?{application:undefined}:{})}))):Response.json({ollama:true,whisper:true,pyannote:true})));
 await useHealthStore.getState().check();expect(useHealthStore.getState().health.whisper).toBe(false);
 recovered=true;await useHealthStore.getState().check(true);expect(useHealthStore.getState().health.whisper).toBe(true);
 for(const invalid of ['<html>Another app</html>',JSON.stringify([{...diagnostics[0],cwd:'/private/account'}])]){
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(invalid)));await useHealthStore.getState().check(true);expect(useHealthStore.getState().health.whisper).toBe(false);expect(JSON.stringify(useHealthStore.getState().health)).not.toContain('/private/account');
  expect(useHealthStore.getState().diagnosticsUnavailable).toBe(true);
 }
});
