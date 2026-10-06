import {expect,test} from 'bun:test';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';

const root=resolve(import.meta.dir,'../../..');
const source=readFileSync(resolve(root,'packages/cli/bin/cli.mjs'),'utf8');
test('fresh fork CLI clone supplies the port helper and identity endpoints it requires',()=>{
 expect(source).toContain('git clone https://github.com/augustocbx/heed-macos.git');
 expect(source).not.toContain('git clone https://github.com/isjunrod/heed.git');
 expect(existsSync(resolve(root,'scripts/service_config.py'))).toBe(true);
 expect(readFileSync(resolve(root,'packages/server/server.ts'),'utf8')).toContain('/.well-known/heed-service');
 expect(readFileSync(resolve(root,'packages/cli/README.md'),'utf8')).toContain('published upstream');
});
test('CLI updater rejects another origin before fetching or changing existing code',()=>{
 const match=source.match(/function assertForkOrigin\(dir\) \{([\s\S]*?)\n\}/);
 expect(match).not.toBeNull();
 const calls:unknown[]=[];let origin='https://github.com/isjunrod/heed.git';
 const check=runInNewContext(`${match![0]};assertForkOrigin`,{execFileSync:(...args:unknown[])=>{calls.push(args);return origin;}});
 expect(()=>check('/synthetic')).toThrow('augustocbx/heed-macos');
 expect(calls).toHaveLength(1);expect(calls[0]).toEqual(['git',['-C','/synthetic','remote','get-url','origin'],{encoding:'utf8'}]);
 for(origin of ['https://github.com/augustocbx/heed-macos.git','git@github.com:augustocbx/heed-macos.git'])expect(()=>check('/synthetic')).not.toThrow();
 expect(source.indexOf('assertForkOrigin(heedDir);')).toBeLessThan(source.indexOf('Checking for updates...'));
 expect(source).toContain('function syncRepoToMain(dir) {\n\tassertForkOrigin(dir);');
});
