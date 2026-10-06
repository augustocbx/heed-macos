#!/usr/bin/env bun
/** Opt-in acceptance using owned public fixtures, production HTTP/UI and real FFmpeg. */
import {createHash, randomUUID} from 'node:crypto';
import {closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync, writeSync} from 'node:fs';
import {basename, dirname, join, resolve, sep} from 'node:path';
import {arch, release} from 'node:os';
import {chromium, type Browser, type Page} from 'playwright';
import {finishOwnedQuotaServices,removeOwnedQuotaFixture,withCaptureQuotaFixture, type QuotaFixture} from '../packages/server/lib/qa/capture-quota-fixture';

const help = 'Usage: bun scripts/check-synchronization-quota.ts --source-root ROOT --output NEW_PUBLIC_REPORT.json --fixture-root NONEXISTENT_PHYSICAL_DIR [--phase pressure|pages|all] [--keep-fixture]';
function requireFact(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message); }
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function command(args: string[], cwd?: string) {
 const result = Bun.spawnSync(args, {cwd});
 requireFact(result.exitCode === 0, `Prerequisite command failed: ${basename(args[0]!)}`);
 requireFact(result.stdout.length < 2_000_000, 'Command output exceeded its bounded allowance');
 return new TextDecoder().decode(result.stdout).trim();
}
function newPhysicalPath(value: string) {
 const path = resolve(value), parent = realpathSync(dirname(path));
 requireFact(parent === dirname(path), 'Destination parent must be a canonical physical path');
 requireFact(!existsSync(path), 'Destination already exists; choose a new owned path');
 try { lstatSync(path); throw Error('Destination already exists'); } catch (error) { requireFact((error as NodeJS.ErrnoException).code === 'ENOENT', 'Destination must not exist, including symbolic links'); }
 return path;
}
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, message: string, timeout = 15000) {
 const deadline = Date.now() + timeout;
 while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await Bun.sleep(150); }
 throw Error(message);
}
function requireFreePorts(ports: number[]) {
 for (const port of new Set(ports)) {
  const lease = Bun.serve({hostname:'127.0.0.1',port,fetch:() => new Response()});lease.stop(true);
 }
}
function boundedUsage(value: any) {
 requireFact(['usedBytes','reservedBytes','limitBytes'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0), 'Quota response contains invalid counters');
 requireFact(value.usedBytes + value.reservedBytes <= value.limitBytes, 'Quota usage exceeded the configured limit');
 return {usedBytes: value.usedBytes, reservedBytes: value.reservedBytes, limitBytes: value.limitBytes};
}
function sourceIdentity(source: string) {
 const files = command(['git','ls-files','-z','--','packages/server','packages/shared','packages/client','config','package.json','VERSION'], source).split('\0').filter(Boolean).sort();
 const entries = files.filter(file => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx')).map(file => {
  const path = join(source,file); requireFact(lstatSync(path).isFile(), 'Source inventory contains a non-regular file');
  return {path:file, sha256:hash(readFileSync(path))};
 });
 return {commit:command(['git','rev-parse','HEAD'],source), trackedProductionSha256:hash(JSON.stringify(entries)), dirty:command(['git','status','--porcelain=v1','--untracked-files=no','--','packages/server','packages/shared','packages/client','config','package.json','VERSION'],source).split('\n').filter(Boolean), files:entries};
}
function copiedIdentity(fixture: QuotaFixture, identity: ReturnType<typeof sourceIdentity>, client: boolean) {
 const selected = identity.files.filter(file => client || !file.path.startsWith('packages/client/'));
 for (const file of selected) requireFact(hash(readFileSync(join(fixture.source,file.path))) === file.sha256, 'Fixture production source differs from the selected source');
 return hash(JSON.stringify(selected));
}
async function pressure(fixture: QuotaFixture) {
 requireFact(process.platform === 'darwin', 'Synthetic native PCM pressure requires macOS');
 const start = await fixture.request('/api/sysrecord/start',{requestId:`public-quota-${randomUUID()}`,mode:'both'});
 requireFact(start.status === 200 && start.body.recording === true, 'Production capture did not enter recording');
 const initial = (await fixture.request('/api/recording/status')).body;
 requireFact(initial.state === 'recording', 'Capture state is not recording');
 const ledger = JSON.parse(readFileSync(join(fixture.root,'quota-reservations.json'),'utf8'));
 const sourceAllowance = Math.floor(ledger.reservations[`capture-${initial.meetingId}`].bytes / 4);
 requireFact(sourceAllowance > 0, 'Capture reservation is absent');
 const samples: ReturnType<typeof boundedUsage>[] = [];
 const state = await eventually(async () => {
  samples.push(boundedUsage((await fixture.request('/api/storage')).body));
  const current = (await fixture.request('/api/recording/status')).body;
  requireFact(current.state !== 'failed', 'Synthetic pressure capture failed'); return current;
 }, value => value.state === 'completed', 'Automatic quota finalization did not complete', 40000);
 requireFact(state.meetingId === initial.meetingId && fixture.finalizeCount() === 1, 'Capture must finalize its original meeting exactly once');
 const sessions = (await fixture.request('/api/sessions')).body;
 requireFact(Array.isArray(sessions) && sessions.length === 1, 'Expected exactly one durable session');
 const session = sessions[0];
 requireFact(session.id === initial.meetingId && session.transcriptFinalized === true && session.transcript === 'Public synthetic quota acceptance.' && session.language === 'en' && session.transcriptionModel === 'synthetic-quota-control', 'Final controlled transcription metadata differs');
 const audio = readFileSync(session.files.wav), wave = fixture.probe(session.files.wav), stream = wave.streams[0];
 requireFact(stream.codec_name === 'pcm_s16le' && stream.sample_rate === '16000' && stream.channels === 2 && Number(wave.format.duration) > 1, 'Production WAV has invalid format or duration');
 requireFact(Math.abs(session.duration - Number(wave.format.duration)) < 0.001, 'Persisted duration differs from actual FFprobe');
 requireFact(audio.length >= sourceAllowance - Math.min(1_000_000,Math.floor(sourceAllowance / 20)), 'Capture ended before the quota pressure margin');
 const finalUsage = boundedUsage((await fixture.request('/api/storage')).body);
 requireFact(finalUsage.reservedBytes === 0 && samples.some(value => value.reservedBytes > 0), 'Capture reservations were not retained and released');
 const desktop = (await fixture.request('/api/desktop/control/status')).body;
 requireFact(desktop.recording === false && desktop.processing === false && desktop.quotaStopped === true, 'Desktop API does not report an automatic quota stop');
 requireFact(Object.keys(JSON.parse(readFileSync(join(fixture.root,'quota-reservations.json'),'utf8')).reservations).length === 0, 'Reservation ledger is not empty');
 requireFact(readdirSync(join(fixture.root,'library/staging')).every(name => !name.startsWith('capture-')), 'Capture staging remained after save');
 const pcm = JSON.parse(readFileSync(join(fixture.temporary,'pcm-source.json'),'utf8'));
 requireFact(pcm.stopped === true && pcm.chunks > 10, 'Paced PCM source was not stopped by the application');
 let alive = true; try {process.kill(pcm.pid,0);} catch (error) {requireFact((error as NodeJS.ErrnoException).code === 'ESRCH','Cannot establish helper process exit');alive = false;}
 requireFact(!alive, 'Owned PCM helper is still running');
 const stop = await fixture.request('/api/sysrecord/stop',{requestId:'public-already-completed',meetingId:session.id});
 requireFact(stop.status === 200 && fixture.finalizeCount() === 1, 'Completed stop was not idempotent');
 await fixture.restart();await requireFixtureIdentity(fixture);
 requireFact((await fixture.request('/api/sessions')).body.length === 1 && (await fixture.request('/api/storage')).body.reservedBytes === 0 && hash(readFileSync(session.files.wav)) === hash(audio), 'Restart changed durable session/audio/reservations');
 return {status:'passed',source:'paced public stereo PCM through production FFmpeg',asr:'controlled HTTP fixture; semantic transcription quality not observed',meetingId:session.id,sourceAllowanceBytes:sourceAllowance,wav:{sha256:hash(audio),bytes:audio.length,codec:stream.codec_name,sampleRate:Number(stream.sample_rate),channels:stream.channels,duration:Number(wave.format.duration)},sessionSha256:hash(JSON.stringify(session)),samples,finalUsage,finalizeCalls:fixture.finalizeCount(),desktopApi:{recording:false,processing:false,quotaStopped:true},ownedPcmProcessStopped:true,restartIdempotent:true};
}
async function requireFixtureIdentity(fixture: QuotaFixture) {
 const identity = await fixture.request('/.well-known/heed-service');
 requireFact(identity.status === 200 && identity.body.service === 'heed-api' && identity.body.protocolVersion === 1 && identity.body.checkoutRoot === realpathSync(fixture.source),'API listener does not belong to the owned fixture');
}
async function fixturePorts(fixture: QuotaFixture) {
 await requireFixtureIdentity(fixture);
 const diagnostics = await fixture.request('/.well-known/heed-services');
 requireFact(diagnostics.status === 200 && Array.isArray(diagnostics.body) && diagnostics.body.length === 3,'Isolated service port diagnostics unavailable');
 const api = diagnostics.body.find((item: any) => item.service === 'api')?.port;
 const transcription = diagnostics.body.find((item: any) => item.service === 'transcription')?.port;
 requireFact(api === Number(new URL(fixture.base()).port) && Number.isSafeInteger(transcription) && transcription > 0 && transcription <= 65535 && transcription !== api,'Isolated sidecar port diagnostics invalid');
 return {api,transcription};
}
async function pages(fixture: QuotaFixture, screenshotRoot: string, ports: {api:number;transcription:number}) {
 // This file was created by the helper in this receipt-owned fixture only.
 rmSync(join(fixture.root,'config.json')); await fixture.restart();await requireFixtureIdentity(fixture);
 requireFact((await fixture.request('/api/storage')).body.limitBytes === 2_000_000_000, 'Missing configuration did not select the decimal 2 GB default');
 const executable = join(fixture.source,'packages/client/node_modules/vite/bin/vite.js');
 requireFact(existsSync(executable), 'Selected source Vite dependency is unavailable');
 let port = 0;
 for (let candidate = 48740; candidate < 48780; candidate++) {
  if ([ports.api,ports.transcription].includes(candidate)) continue;
  try {const lease = Bun.serve({hostname:'127.0.0.1',port:candidate,fetch:()=>new Response()});port = candidate;lease.stop(true);break;} catch {}
 }
 requireFact(port > 0, 'No free owned UI acceptance port');
 writeFileSync(join(fixture.root,'service-ports.json'),JSON.stringify({version:1,api:ports.api,ui:port,transcription:ports.transcription}),{flag:'wx',mode:0o600});
 await fixture.restart();await requireFixtureIdentity(fixture);
 const env: Record<string,string | undefined> = {...process.env,HEED_APP_DIR:fixture.root,HEED_UI_PORT:String(port),HEED_API_PORT:String(ports.api),HEED_TRANSCRIPTION_PORT:String(ports.transcription),HEED_TRANSCRIPTION_URL:`http://127.0.0.1:${ports.transcription}`,OLLAMA_HOST:`http://127.0.0.1:${ports.transcription}`};
 for (const name of ['PORT','HEED_SERVICE_CONFIG_ROOT','VITE_API_BASE']) delete env[name];
 const vite = Bun.spawn([process.execPath,executable,'--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:join(fixture.source,'packages/client'),env,stdout:'ignore',stderr:'pipe'});
 const diagnostics = new Response(vite.stderr).text();
 let browser: Browser | undefined;
 try {
  await eventually(async () => {try {return (await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(1000)})).ok;} catch {return false;}}, value => value, 'Owned production Vite UI did not start', 10000);
  browser = await chromium.launch({headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:1080},locale:'en-US'});context.setDefaultTimeout(15000);
  await context.route('**/*',route => {
   const url = new URL(route.request().url());
   return url.hostname === '127.0.0.1' && [port,Number(new URL(fixture.base()).port)].includes(Number(url.port)) ? route.continue() : route.abort('blockedbyclient');
  });
  // Only introductory overlays are dismissed in this fresh synthetic browser.
  await context.addInitScript(() => {localStorage.setItem('heed-setup-skipped','1');localStorage.setItem('heed-tour-done','1');});
  const a = await context.newPage(), b = await context.newPage();
  const navigate = async () => {await Promise.all([a.goto(`http://127.0.0.1:${port}/#settings`),b.goto(`http://127.0.0.1:${port}/#settings`)]);};
  const card = (page: Page) => page.locator('article[aria-labelledby="meeting-storage-title"]');
  const input = (page: Page) => page.locator('#meeting-storage-limit');
  const waitValue = (page: Page,value: string) => eventually(async () => ({value:await input(page).inputValue(),enabled:await input(page).isEnabled()}),actual => actual.value === value && actual.enabled, `Production page did not display an enabled ${value} GB input`);
  const save = async (page: Page,value: string,reset = false) => {
   if (!reset) await input(page).fill(value);
   await card(page).locator(':scope > button').nth(reset ? 1 : 0).click();
   await eventually(async () => {
    const alert = card(page).locator('[role=alert]');
    requireFact(await alert.count() === 0,'Visible quota preview was refused');
    return card(page).locator('section[aria-labelledby=storage-review-title]').count();
   },count => count === 1,'Reviewed quota preview did not appear');
   await card(page).locator('section[aria-labelledby="storage-review-title"] button').nth(0).click();
   await eventually(() => fixture.request('/api/storage'),result => result.body.limitBytes === Number(value) * 1_000_000_000,'Reviewed quota change was not persisted');
   await waitValue(page,value);
  };
  const authoritative = async (bytes: number) => {
   const storage = boundedUsage((await fixture.request('/api/storage')).body), desktop = (await fixture.request('/api/desktop/control/status')).body;
   const config = JSON.parse(readFileSync(join(fixture.root,'config.json'),'utf8'));
   requireFact(config.storage_limit_bytes === bytes && storage.limitBytes === bytes && desktop.storage.limitBytes === bytes, 'Persisted, storage and desktop limits disagree');
   return {persistedLimitBytes:config.storage_limit_bytes,storageApiLimitBytes:storage.limitBytes,desktopApiLimitBytes:desktop.storage.limitBytes};
  };
  await navigate();await Promise.all([waitValue(a,'2'),waitValue(b,'2')]);
  const results: any[] = [];
  for (const locale of ['en','pt-BR','fr','de']) {
   await a.locator('#interface-language').selectOption(locale);
   await eventually(() => b.locator('#interface-language').inputValue(),value => value === locale,'Second production page did not synchronize interface locale');
   await save(a,'2',true);await Promise.all([a.reload(),b.reload()]);await Promise.all([waitValue(a,'2'),waitValue(b,'2')]);
   await save(a,'3');await waitValue(b,'3');
   const initial = await authoritative(3_000_000_000);
   const visibleTitles = {a:await a.locator('#meeting-storage-title').innerText(),b:await b.locator('#meeting-storage-title').innerText()};
   requireFact(visibleTitles.a === visibleTitles.b && await a.locator('html').getAttribute('lang') === locale && await b.locator('html').getAttribute('lang') === locale,'Visible pages did not both adopt the selected locale');
   const screenshots: any[] = [];
   for (const [alias,page] of [['a',a],['b',b]] as const) {
    const filename = `${locale}-${alias}.png`, image = await card(page).screenshot();
    requireFact(image.length <= 2_000_000,'Public screenshot exceeded its allowance');
    writeFileSync(join(screenshotRoot,filename),image,{flag:'wx',mode:0o600});
    screenshots.push({file:filename,sha256:hash(image),bytes:image.length});
   }
   await input(b).fill('4');await authoritative(3_000_000_000);await save(a,'2',true);
   await eventually(() => card(b).locator('dl > div').first().locator('dd').innerText(),value => value === '2 GB','Second page usage maximum did not propagate while its input was dirty');
   requireFact(await input(b).inputValue() === '4','Second page unsaved draft was overwritten');
   await authoritative(2_000_000_000);
   await card(b).locator(':scope > button').nth(0).click();
   await card(b).locator('section[aria-labelledby="storage-review-title"] button').nth(1).click();
   await authoritative(2_000_000_000);
   await save(a,'3');await fixture.restart();await requireFixtureIdentity(fixture);
   const persisted = await authoritative(3_000_000_000);
   await Promise.all([a.reload(),b.reload()]);await Promise.all([waitValue(a,'3'),waitValue(b,'3')]);
   results.push({locale,visibleTitles,status:'passed',pageA:'reviewed 2 to 3 GB',pageB:'clean input propagated; 4 GB dirty draft preserved during 2 GB update',cancelDidNotPersist:true,...initial,restart:persisted,screenshots});
  }
  return {status:'passed',missingConfigurationDefaultBytes:2_000_000_000,browser:browser.version(),nativeMenu:'not-observed',locales:results};
 } catch (error) {
  writeFileSync(join(fixture.temporary,'page-error.txt'),String((error as Error).stack).slice(0,64000),{flag:'wx',mode:0o600});throw error;
 } finally {
  await finishOwnedQuotaServices([
   async()=>{await Promise.race([browser?.close(),Bun.sleep(5000).then(()=>{throw Error('Owned browser did not stop');})]);},
   async()=>{vite.kill();await Promise.race([vite.exited,Bun.sleep(5000).then(()=>{throw Error('Owned UI process did not stop');})]);await diagnostics;requireFreePorts([port]);},
  ]);
 }
}

async function main() {
 const args = process.argv.slice(2), options: Record<string,string | boolean> = {};
 if (args.includes('--help')) {console.log(help);return;}
 for (let index = 0; index < args.length; index++) {
  const key = args[index]!;requireFact(['--source-root','--output','--fixture-root','--phase','--keep-fixture'].includes(key) && options[key] === undefined,help);
  if (key === '--keep-fixture') options[key] = true;
  else {const value = args[++index];requireFact(typeof value === 'string' && !value.startsWith('--'),help);options[key] = value;}
 }
 requireFact(['--source-root','--output','--fixture-root'].every(key => typeof options[key] === 'string' && options[key]),help);
 const phase = options['--phase'] ?? 'all';requireFact(['pressure','pages','all'].includes(String(phase)),help);
 const source = realpathSync(String(options['--source-root']));
 requireFact(resolve(String(options['--source-root'])) === source && lstatSync(join(source,'package.json')).isFile(),'Source must be a canonical physical Heed checkout');
 requireFact(JSON.parse(readFileSync(join(source,'package.json'),'utf8')).name === 'heed','Source is not a Heed checkout');
 const output = newPhysicalPath(String(options['--output'])), root = newPhysicalPath(String(options['--fixture-root']));
 requireFact(!output.startsWith(root + sep) && !root.startsWith(source + sep) && !output.startsWith(source + sep),'Public report and fixture must be outside the selected source; report must survive fixture cleanup');
 const identity = sourceIdentity(source);
 requireFact(hash(readFileSync(join(source,'packages/server/lib/qa/capture-quota-fixture.ts'))) === hash(readFileSync(resolve(import.meta.dir,'../packages/server/lib/qa/capture-quota-fixture.ts'))),'Selected source fixture helper differs from the executing harness');
 const report: any = {version:1,kind:'public-synthetic-quota-acceptance',startedAt:new Date().toISOString(),source:{...identity,harnessSha256:hash(readFileSync(import.meta.path)),fixtureHelperSha256:hash(readFileSync(join(source,'packages/server/lib/qa/capture-quota-fixture.ts')))},environment:{platform:process.platform,architecture:arch(),deviceAlias:'local-mac',osRelease:release(),macOS:process.platform === 'darwin' ? command(['/usr/bin/sw_vers','-productVersion']) : null,bun:Bun.version,ffmpeg:command(['ffmpeg','-version']).split('\n')[0],ffprobe:command(['ffprobe','-version']).split('\n')[0]},nativeMenu:'not-observed',physicalCapture:'not-observed',realAsr:'not-observed',installedFreshUpgradeReinstall:'not-observed',status:'running'};
 const outputFd = openSync(output,'wx',0o600), outputReceipt = fstatSync(outputFd);
 mkdirSync(root,{mode:0o700});const receipt = lstatSync(root);
 writeFileSync(join(root,'ownership.json'),JSON.stringify({version:1,kind:'public-quota-acceptance',runId:randomUUID(),pid:process.pid}),{flag:'wx',mode:0o600});
 let screenshotRoot: string | undefined;const ownedPorts: number[] = [];let servicesVerified = false;
 const observePorts = async (fixture: QuotaFixture) => {const ports = await fixturePorts(fixture);ownedPorts.push(ports.api,ports.transcription);return ports;};
 try {
  if (phase === 'pressure' || phase === 'all') await withCaptureQuotaFixture({sourceRoot:source,limit:4_000_000,fixtureRoot:join(root,'pressure'),keepFixture:options['--keep-fixture'] === true},async fixture => {await observePorts(fixture);report.pressureSourceSha256 = copiedIdentity(fixture,identity,false);report.pressure = await pressure(fixture);});
  if (phase === 'pages' || phase === 'all') {
   screenshotRoot = newPhysicalPath(output + '.screenshots');mkdirSync(screenshotRoot,{mode:0o700});
   report.screenshotDirectory = basename(screenshotRoot);
   await withCaptureQuotaFixture({sourceRoot:source,limit:2_000_000_000,fixtureRoot:join(root,'pages'),keepFixture:options['--keep-fixture'] === true,includeClient:true},async fixture => {const ports = await observePorts(fixture);report.pagesSourceSha256 = copiedIdentity(fixture,identity,true);report.pages = await pages(fixture,screenshotRoot!,ports);});
  }
  requireFreePorts(ownedPorts);servicesVerified = true;report.status = 'passed';
 } catch (error) {
  report.status = 'failed';
  // Errors contain fixture assertions only; diagnostics remain private.
  const message = (error as Error).message;
  report.failure = message.split('\n')[0]!.includes(source) || message.includes(root) || message.includes(output) ? 'Acceptance failed; inspect the private fixture diagnostics.' : message.split('\n')[0]!.replace(/\/[^\s]+/g,'[local path]');
  process.exitCode = 1;
 } finally {
  report.finishedAt = new Date().toISOString();report.ownedServicesStopped = servicesVerified ? true : 'not-verified-by-report';
  try {
   report.fixtureCleanup=removeOwnedQuotaFixture(root,receipt,{keep:options['--keep-fixture']===true,servicesVerified});
  } catch {
   report.status = 'failed';report.fixtureCleanup = 'refused-or-incomplete';process.exitCode = 1;
  }
  try {
   requireFact(fstatSync(outputFd).ino === outputReceipt.ino && lstatSync(output).ino === outputReceipt.ino,'Public report descriptor authority changed');
   writeSync(outputFd,JSON.stringify(report,null,2) + '\n');
  } finally {closeSync(outputFd);}
 }
 console.log(`Public synthetic quota acceptance: ${report.status}.`);
}
await main();
