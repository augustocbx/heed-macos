import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('new, legacy, and malformed saved values default on; explicit false persists without losing other config',()=>{
 const directory=mkdtempSync(join(tmpdir(),'heed-preview-preference-'));
 const config=join(directory,'config.json');
 const code=`import {realTimeTranscription,saveConfig} from ${JSON.stringify(resolve(import.meta.dir,'app-config.ts'))};console.log(realTimeTranscription());if(process.env.SAVE_OFF)saveConfig({real_time_transcription:false});`;
 const run=(save=false)=>{
  const child=Bun.spawnSync([process.execPath,'-e',code],{env:{...process.env,HEED_APP_DIR:directory,...(save?{SAVE_OFF:'1'}:{})}});
  expect(child.exitCode).toBe(0);return child.stdout.toString().trim();
 };
 try{
  expect(run()).toBe('true');
  for(const value of [undefined,'false',0,null,{}]){
   writeFileSync(config,JSON.stringify({real_time_transcription:value,user_name:'Fixture owner'}));expect(run()).toBe('true');
  }
  expect(run(true)).toBe('true');expect(run()).toBe('false');
  expect(JSON.parse(readFileSync(config,'utf8'))).toEqual({real_time_transcription:false,user_name:'Fixture owner'});
 }finally{rmSync(directory,{recursive:true,force:true});}
});
