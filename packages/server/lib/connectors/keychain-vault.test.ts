import {test,expect} from 'bun:test';
import {createKeychainVault} from './keychain-vault';
test('keeps tokens and upload URLs in stdin behind opaque durable refs',async()=>{
 const stored=new Map<string,string>();const invocations:string[][]=[];const vault=createKeychainVault({helperPath:'/isolated/heed-keychain',run:async(command:string[],stdin:string)=>{
  invocations.push(command);const request=JSON.parse(stdin);
  expect(request.service).toBe('local.heed.connectors.v1');
  if(request.operation==='put')stored.set(request.reference,request.value);
  if(request.operation==='remove')stored.delete(request.reference);
  return {code:0,stdout:JSON.stringify({ok:true,...(request.operation==='get'?{value:stored.get(request.reference)??null}:{})})};
 }});
 const ref=await vault.put({refreshToken:'SECRET_REFRESH',uploadUrl:'https://upload.example/SECRET_SESSION'});expect(ref).toMatch(/^[a-f0-9-]{36}$/);
 expect(JSON.stringify(invocations)).not.toContain('SECRET');expect(await vault.get<Record<string,string>>(ref)).toEqual({refreshToken:'SECRET_REFRESH',uploadUrl:'https://upload.example/SECRET_SESSION'});
 expect(await vault.put({accessToken:'UPDATED'},ref)).toBe(ref);expect(await vault.get<Record<string,string>>(ref)).toEqual({accessToken:'UPDATED'});await vault.remove(ref);expect(await vault.get<Record<string,string>>(ref)).toBeNull();
});
test('unavailable, locked, oversized and invalid-reference vault operations fail closed',async()=>{
 const vault=createKeychainVault({helperPath:'/fake',run:async()=>({code:1,stdout:JSON.stringify({ok:false,error:'locked'})})});
 await expect(vault.get('not-ref')).rejects.toThrow('Invalid secret reference');await expect(vault.put({token:'secret'})).rejects.toThrow('Protected credential storage is unavailable');
 await expect(vault.put({token:'s'.repeat(70000)})).rejects.toThrow('Secret exceeds');
});
