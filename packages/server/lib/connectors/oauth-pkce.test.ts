import {describe,test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {beginDesktopOAuth} from './oauth-pkce';
const endpoint='https://accounts.google.com/o/oauth2/v2/auth';
describe('desktop OAuth loopback',()=>{
 test('binds fresh state and S256 verifier to a one-use exact loopback callback',async()=>{
  let authorization:URL|undefined;let callback='';
  const result=await beginDesktopOAuth({authorizationEndpoint:endpoint,clientId:'public-client',scopes:['scope-a'],parameters:{access_type:'offline'},openBrowser:async(url:string)=>{
   authorization=new URL(url);callback=authorization.searchParams.get('redirect_uri')!;
   const rejected=await fetch(`${callback}?code=ATTACK&state=wrong`);expect(rejected.status).toBe(400);
   expect((await fetch(`${callback}?code=ATTACK&state=${'é'.repeat(43)}`)).status).toBe(400);
   expect((await fetch(`${callback}?code=SECRET_CODE&state=${authorization.searchParams.get('state')}`,{method:'POST'})).status).toBe(405);
   expect((await fetch(`${callback}?code=SECRET_CODE&state=${authorization.searchParams.get('state')}`,{headers:{Origin:'https://hostile.example'}})).status).toBe(403);
   expect((await fetch(`${callback}?code=SECRET_CODE&state=${authorization.searchParams.get('state')}`)).status).toBe(200);
  }});
  expect(result.code).toBe('SECRET_CODE');expect(result.redirectUri).toBe(callback);
  expect(result.codeVerifier.length).toBeGreaterThanOrEqual(43);expect(authorization!.searchParams.get('code_challenge')).toBe(createHash('sha256').update(result.codeVerifier).digest('base64url'));
  expect(authorization!.searchParams.get('code_challenge_method')).toBe('S256');expect(authorization!.searchParams.get('access_type')).toBe('offline');
  await expect(fetch(`${callback}?code=REPLAY&state=${authorization!.searchParams.get('state')}`)).rejects.toThrow();
 });
 test('denial consumes the attempt without leaking provider error text',async()=>{
  await expect(beginDesktopOAuth({authorizationEndpoint:endpoint,clientId:'client',scopes:['scope'],openBrowser:async(url:string)=>{
   const u=new URL(url);await fetch(`${u.searchParams.get('redirect_uri')}?error=access_denied&error_description=SECRET&state=${u.searchParams.get('state')}`);
  }})).rejects.toThrow('Authorization was denied');
 });
 test('cancellation and timeout close only their attempt listener',async()=>{
  const controller=new AbortController();let callback='';
  await expect(beginDesktopOAuth({authorizationEndpoint:endpoint,clientId:'client',scopes:['scope'],signal:controller.signal,openBrowser:async(url:string)=>{callback=new URL(url).searchParams.get('redirect_uri')!;controller.abort();}})).rejects.toThrow('Authorization cancelled');
  await expect(fetch(callback)).rejects.toThrow();
  await expect(beginDesktopOAuth({authorizationEndpoint:endpoint,clientId:'client',scopes:['scope'],timeoutMs:20,openBrowser:async()=>{}})).rejects.toThrow('Authorization timed out');
 });
 test('rejects unsafe endpoints and reserved parameter overrides before opening browser',async()=>{
  for(const input of [{authorizationEndpoint:'http://remote.example/auth'},{parameters:{state:'fixed'}}]){
   let opened=false;await expect(beginDesktopOAuth({authorizationEndpoint:endpoint,clientId:'client',scopes:['scope'],...input,openBrowser:async()=>{opened=true;}})).rejects.toThrow();expect(opened).toBe(false);
  }
 });
});
