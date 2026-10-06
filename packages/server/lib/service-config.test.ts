import {test,expect} from 'bun:test';
import {serviceConfig,servicePort,localServiceUrl} from '../../shared/lib/service-config';
test('canonical defaults and validated overrides agree across services',()=>{
 expect(serviceConfig({})).toEqual({api:48100,ui:48101,transcription:48102});
 expect(serviceConfig({HEED_API_PORT:'48110',HEED_UI_PORT:'48111',HEED_TRANSCRIPTION_PORT:'48112'})).toEqual({api:48110,ui:48111,transcription:48112});
 expect(serviceConfig({PORT:'48110'}).api).toBe(48110);
 expect(()=>serviceConfig({PORT:'48110',HEED_API_PORT:'48120'})).toThrow('disagree');
 expect(()=>serviceConfig({HEED_API_PORT:'48101'})).toThrow('distinct');
});
test('invalid or owner-forbidden ports fail before bind',()=>{
 for(const port of ['','0','65536','-1','1.5',' 48100','48100x','3000','3999','5000','5999','7000','7999','8000','8999'])expect(()=>servicePort(port,'test')).toThrow();
 for(const port of ['2999','4000','4999','6000','6999','9000','11434','48100','65535'])expect(servicePort(port,'test')).toBe(Number(port));
});
test('explicit external sidecar overrides remain local and outside forbidden ranges',()=>{
 expect(localServiceUrl('http://localhost:48122/','sidecar')).toBe('http://localhost:48122');
 for(const url of ['https://outside.example:48122','http://127.0.0.1:5002','http://localhost:48122/private','http://user:password@localhost:48122','http://localhost:48122?token=x'])expect(()=>localServiceUrl(url,'sidecar')).toThrow();
});
