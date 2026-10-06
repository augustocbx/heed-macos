import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {configuredServicePorts} from './service-ports';
test('device ports restore envless consumers while explicit overrides take precedence',()=>{
 const app=mkdtempSync(join(tmpdir(),'heed-device-ports-'));const env={HEED_APP_DIR:app};
 try{writeFileSync(join(app,'service-ports.json'),JSON.stringify({version:1,api:48110,ui:48111,transcription:48112}));
 expect(configuredServicePorts(env)).toEqual({api:48110,ui:48111,transcription:48112});
 expect(configuredServicePorts({...env,PORT:'48120'}).api).toBe(48120);
 expect(configuredServicePorts({...env,HEED_API_PORT:'48120'}).api).toBe(48120);
 for(const value of ['{invalid',JSON.stringify({version:1,api:5001,ui:48111,transcription:48112}),JSON.stringify({version:1,api:48110,ui:48110,transcription:48112}),' '.repeat(4097)]){writeFileSync(join(app,'service-ports.json'),value);expect(()=>configuredServicePorts(env)).toThrow();}
 }finally{rmSync(app,{recursive:true,force:true});}
});
test('device config rejects symlinks before reading',()=>{const app=mkdtempSync(join(tmpdir(),'heed-device-link-'));try{symlinkSync(join(app,'missing'),join(app,'service-ports.json'));expect(()=>configuredServicePorts({HEED_APP_DIR:app})).toThrow();}finally{rmSync(app,{recursive:true,force:true});}});
