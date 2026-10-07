import {untrack} from './process';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PythonDirectSmbNative } from './smb-direct-native';
import type { DirectSmbProbe } from './smb-direct-types';
import {
	validateDirectEndpoint,
	validateDirectCredentials,
	validateDirectProbe,
} from './smb-direct-types';

const endpoint = {
	server: 'nas.local',
	port: 445,
	share: 'meetings',
	folder: 'Heed/library',
	requireEncryption: false,
};
const credentials = { username: 'reviewer', password: 'secret-never-log', domain: '' };
const identity = {
	serverGuid: '0123456789abcdef0123456789abcdef',
	volumeSerial: '00000001',
	volumeCreated: '01db000000000001',
	rootId: '0000000000000010',
	rootCreated: '01db000000000002',
};
const probe: DirectSmbProbe = {
	identity,
	dialect: '3.1.1',
	authentication: 'authenticated',
	security: 'signed',
	encrypted: false,
	readOnly: false,
	namespaceSafe: true,
	destinationId: null,
	destinationVersion: null,
	empty: true,
};
const binding = {
	id: '11111111-1111-4111-8111-111111111111',
	name: 'Test',
	endpoint,
	identity,
	destinationId: '22222222-2222-4222-8222-222222222222',
	destinationVersion: 3 as const,
	connectionGeneration: '33333333-3333-4333-8333-333333333333',
	credentialRef: '44444444-4444-4444-8444-444444444444',
	readOnly: false,
	security: 'signed' as const,
};
const context = {
	operationId: '55555555-5555-4555-8555-555555555555',
	deviceId: '66666666-6666-4666-8666-666666666666',
	kind: 'read' as const,
	appDir: '/private/tmp/heed-task1',
};
function helper(code: string) {
	let child: ReturnType<typeof Bun.spawn>;
	return {
		runner: () => {
			child = Bun.spawn([process.execPath, '-e', code], {
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'ignore',
			});
			return child;
		},
		get child() {
			return child!;
		},
	};
}
const start = `let b='';for await(const x of Bun.stdin.stream()){b+=Buffer.from(x).toString();if(b.includes('\\n'))break;}`;

describe('direct SMB input and receipts', () => {
	test('canonicalizes reviewed DNS aliases and IDNA', () => {
		expect(validateDirectEndpoint({ ...endpoint, server: 'NAS.Local.' }).server).toBe('nas.local');
		expect(validateDirectEndpoint({ ...endpoint, server: 'bücher.example' }).server).toBe(
			'xn--bcher-kva.example',
		);
		expect(validateDirectEndpoint({ ...endpoint, folder: '' }).folder).toBe('');
	});
	test('rejects traversal, credential URLs, ambiguous components and extra fields', () => {
		for (const server of [
			'smb://user:password@nas/share',
			'nas:445',
			'nas\n.local',
			'nas..local',
			'127.00.0.1',
			'nas%2elocal',
		])
			expect(() => validateDirectEndpoint({ ...endpoint, server })).toThrow();
		for (const folder of [
			'/foo',
			'foo/../bar',
			'foo//bar',
			'foo%2fbar',
			'foo\\bar',
			'foo:bar',
			'foo.',
			'foo ',
			'CON',
			'foo\u0000bar',
		])
			expect(() => validateDirectEndpoint({ ...endpoint, folder })).toThrow();
		expect(() => validateDirectEndpoint({ ...endpoint, password: 'secret' })).toThrow();
		expect(() => validateDirectEndpoint({ ...endpoint, port: 0 })).toThrow();
		for (const port of [139, 5001, 48445])
			expect(() => validateDirectEndpoint({ ...endpoint, port })).toThrow();
		expect(validateDirectEndpoint({ ...endpoint, server: 'localhost', port: 48445 }).port).toBe(
			48445,
		);
	});
	test('credentials preserve the password and reject controls and hidden fields', () => {
		expect(validateDirectCredentials({ ...credentials, password: ' p a s s ' })).toEqual({
			...credentials,
			password: ' p a s s ',
		});
		for (const value of [
			{ ...credentials, username: '' },
			{ ...credentials, username: 'name\n' },
			{ ...credentials, password: 'secret\0' },
			{ ...credentials, password: 'bad\ud800' },
			{ ...credentials, domain: '../domain' },
			{ ...credentials, token: 'secret' },
		])
			expect(() => validateDirectCredentials(value)).toThrow();
	});
	test('rejects guest, SMB2, unknown protection and invalid stable receipts', () => {
		for (const value of [
			{ ...probe, dialect: '2.1' },
			{ ...probe, authentication: 'guest' },
			{ ...probe, security: 'unknown' },
			{ ...probe, security: 'encrypted' },
			{ ...probe, identity: { ...identity, rootId: 'ffffffffffffffff' } },
			{ ...probe, identity: { ...identity, rootCreated: '0000000000000000' } },
			{ ...probe, identity: { ...identity, rootCreated: 'fffffffffffffffe' } },
			{ ...probe, destinationVersion: 3 },
		])
			expect(() => validateDirectProbe(value)).toThrow();
		expect(validateDirectProbe(probe)).toEqual(probe);
		expect(validateDirectProbe({ ...probe, security: 'encrypted', encrypted: true })).toMatchObject(
			{ security: 'encrypted' },
		);
	});
});

describe('bounded protected guardian protocol', () => {
	test('credentials travel only on stdin and helper stderr never becomes an error', async () => {
		const h = helper(
			`${start}if(process.argv.some(a=>a.includes('secret-never-log')))process.exit(2);const request=JSON.parse(b.split('\\n')[0]);if(request.credentials.password!=='secret-never-log')process.exit(3);console.error('secret-never-log raw SDK error');console.log(JSON.stringify({ok:false,error:'raw secret-never-log'}));`,
		);
		await expect(
			new PythonDirectSmbNative({ runner: h.runner }).probe(endpoint, credentials),
		).rejects.toThrow('Direct SMB operation unavailable.');
		expect(await h.child.exited).not.toBeNull();
	});
	test('validates a probe and rejects an extra response frame', async () => {
		const h = helper(
			`${start}console.log(JSON.stringify({ok:true,value:${JSON.stringify(probe)}}));`,
		);
		expect(
			await new PythonDirectSmbNative({ runner: h.runner }).probe(endpoint, credentials),
		).toEqual(probe);
		const extra = helper(
			`${start}console.log(JSON.stringify({ok:true,value:${JSON.stringify(probe)}}));console.log('{}');`,
		);
		await expect(
			new PythonDirectSmbNative({ runner: extra.runner }).probe(endpoint, credentials),
		).rejects.toThrow();
	});
	test('refuses a changed initialization receipt and required encryption downgrade', async () => {
		const h = helper(
			`${start}console.log(JSON.stringify({ok:true,value:${JSON.stringify({ ...probe, identity: { ...identity, rootId: '0000000000000011' }, destinationId: binding.destinationId, destinationVersion: 3, empty: false })}}));`,
		);
		await expect(
			new PythonDirectSmbNative({ runner: h.runner }).initialize(
				endpoint,
				credentials,
				identity,
				binding.destinationId,
			),
		).rejects.toThrow();
		const signed = helper(
			`${start}console.log(JSON.stringify({ok:true,value:${JSON.stringify(probe)}}));`,
		);
		await expect(
			new PythonDirectSmbNative({ runner: signed.runner }).probe(
				{ ...endpoint, requireEncryption: true },
				credentials,
			),
		).rejects.toThrow();
	});
	test('rejects oversized startup results and reaps a cancelled helper', async () => {
		const oversized = helper(`${start}console.log('x'.repeat(200000));setInterval(()=>{},1000);`);
		await expect(
			new PythonDirectSmbNative({ runner: oversized.runner, timeoutMs: 1000 }).probe(
				endpoint,
				credentials,
			),
		).rejects.toThrow();
		expect(await oversized.child.exited).not.toBeNull();
		const hanging = helper('setInterval(()=>{},1000)');
		const controller = new AbortController();
		const result = new PythonDirectSmbNative({ runner: hanging.runner, timeoutMs: 1000 }).probe(
			endpoint,
			credentials,
			controller.signal,
		);
		setTimeout(() => controller.abort(), 20);
		await expect(result).rejects.toThrow();
		expect(await hanging.child.exited).not.toBeNull();
	});
	test('checks sequence and chunk bounds before yielding remote bytes', async () => {
		const h = helper(
			`let b='';for await(const x of Bun.stdin.stream()){b+=Buffer.from(x).toString();for(;;){const n=b.indexOf('\\n');if(n<0)break;const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(!r.id)console.log(JSON.stringify({ok:true,ready:true,checkpointed:false}));else console.log(JSON.stringify({id:r.id+1,nonce:r.nonce,bytes:1}));}}`,
		);
		const session = await new PythonDirectSmbNative({ runner: h.runner }).open(
			binding,
			credentials,
			context,
		);
		await expect(session.read('objects/abc', 8)).rejects.toThrow();
		await session.close();
		expect(await h.child.exited).not.toBeNull();
	});
	test('sends bounded binary payload after its validated frame and closes once', async () => {
		const data = Buffer.from('abc');
		const h = helper(
			`let b=Buffer.alloc(0),started=false;for await(const x of Bun.stdin.stream()){b=Buffer.concat([b,Buffer.from(x)]);if(!started){const n=b.indexOf(10);if(n<0)continue;b=b.subarray(n+1);started=true;console.log(JSON.stringify({ok:true,ready:true,checkpointed:false}));}const n=b.indexOf(10);if(n>=0){const r=JSON.parse(b.subarray(0,n).toString());if(r.action==='write'&&b.length>=n+1+r.bytes){if(b.subarray(n+1).toString()!=='abc')process.exit(2);console.log(JSON.stringify({id:r.id,nonce:r.nonce,ok:true,value:null}));b=Buffer.alloc(0);}}}`,
		);
		const session = await new PythonDirectSmbNative({ runner: h.runner }).open(
			binding,
			credentials,
			context,
		);
		await session.write(
			'objects/abc',
			3,
			createHash('sha256').update(data).digest('hex'),
			(async function* () {
				yield data;
			})(),
		);
		await session.close();
		await session.close();
		expect(await h.child.exited).not.toBeNull();
	});
	test('bounds duplicate responses and oversized binary chunks before consumption', async () => {
		const duplicate = helper(
			`${start}console.log('{"ok":true,"ok":false,"error":"secret-never-log"}');`,
		);
		await expect(
			new PythonDirectSmbNative({ runner: duplicate.runner }).probe(endpoint, credentials),
		).rejects.toThrow();
		const h = helper(
			`let b='';for await(const x of Bun.stdin.stream()){b+=Buffer.from(x).toString();for(;;){const n=b.indexOf('\\n');if(n<0)break;const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);console.log(JSON.stringify(r.id?{id:r.id,nonce:r.nonce,bytes:131073}:{ok:true,ready:true,checkpointed:false}));}}`,
		);
		const session = await new PythonDirectSmbNative({ runner: h.runner }).open(
			binding,
			credentials,
			context,
		);
		await expect(session.read('objects/abc', 200000)).rejects.toThrow();
		await session.close();
		expect(await h.child.exited).not.toBeNull();
	});
	test('rejects missing private context and credential-bearing RPC before sending', async () => {
		let started = false;
		const native = new PythonDirectSmbNative({
			runner: () => {
				started = true;
				throw new Error('unexpected launch');
			},
		});
		const { appDir, ...missing } = context;
		await expect(native.open(binding, credentials, missing as typeof context)).rejects.toThrow();
		expect(started).toBe(false);
		const h = helper(
			`${start}console.log(JSON.stringify({ok:true,ready:true,checkpointed:false}));setInterval(()=>{},1000);`,
		);
		const session = await new PythonDirectSmbNative({ runner: h.runner }).open(
			binding,
			credentials,
			context,
		);
		await expect(session.command('list', { path: 'objects', credentials })).rejects.toThrow();
		await expect(
			session.command('list', { path: '', nonce: '0'.repeat(64) }),
		).rejects.toMatchObject({ code: 'invalid-input' });
		await session.close();
		expect(await h.child.exited).not.toBeNull();
	});
	test('timeout rejects a stalled source and reaps its helper', async () => {
		const h = helper(
			`let b='';for await(const x of Bun.stdin.stream()){b+=Buffer.from(x).toString();for(;;){const n=b.indexOf('\\n');if(n<0)break;const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);console.log(JSON.stringify(r.id?{id:r.id,nonce:r.nonce,ok:true,value:null}:{ok:true,ready:true,checkpointed:false}));}}`,
		);
		const session = await new PythonDirectSmbNative({ runner: h.runner, timeoutMs: 100 }).open(
			binding,
			credentials,
			context,
		);
		const stalled = {
			async *[Symbol.asyncIterator]() {
				await new Promise(() => {});
				yield Buffer.from('abc');
			},
		};
		const result = session.write(
			'objects/abc',
			3,
			createHash('sha256').update('abc').digest('hex'),
			stalled,
		);
		await expect(
			Promise.race([
				result,
				new Promise((_, reject) => setTimeout(() => reject(new Error('write did not stop')), 400)),
			]),
		).rejects.toThrow('Direct SMB operation unavailable.');
		await session.close();
		expect(await h.child.exited).not.toBeNull();
	});
	test('buffered reads refuse an unbounded allocation', async () => {
		const h = helper(
			`${start}console.log(JSON.stringify({ok:true,ready:true,checkpointed:false}));setInterval(()=>{},1000);`,
		);
		const session = await new PythonDirectSmbNative({ runner: h.runner, timeoutMs: 100 }).open(
			binding,
			credentials,
			context,
		);
		await expect(session.read('objects/abc', 17 * 1024 * 1024)).rejects.toMatchObject({
			code: 'bounds-exceeded',
		});
		await session.close();
		expect(await h.child.exited).not.toBeNull();
	});
	test.each(['terminal', 'chunk'])(
		'rejects trailing %s frames, reaps, and never dispatches request two',
		async (extra) => {
			const directory = mkdtempSync(join(tmpdir(), 'heed-smb-framing-'));
			const log = join(directory, 'requests');
			const h = helper(
				`const {appendFileSync}=require('node:fs');let b='';for await(const x of Bun.stdin.stream()){b+=Buffer.from(x).toString();for(;;){const n=b.indexOf('\\n');if(n<0)break;const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(!r.id){console.log(JSON.stringify({ok:true,ready:true,checkpointed:false}));continue;}appendFileSync(${JSON.stringify(log)},r.id+'\\n');const correlation=r.nonce?{nonce:r.nonce}:{};const first={id:r.id,...correlation,ok:true,value:null};const next=${JSON.stringify(extra)}==='chunk'?JSON.stringify({id:r.id+1,...correlation,bytes:3})+'\\nXYZ'+JSON.stringify({id:r.id+1,...correlation,ok:true,value:null})+'\\n':JSON.stringify({id:r.id+1,...correlation,ok:true,value:null})+'\\n';await Bun.write(Bun.stdout,JSON.stringify(first)+'\\n'+next);}}`,
			);
			const session = await new PythonDirectSmbNative({ runner: h.runner }).open(
				binding,
				credentials,
				context,
			);
			try {
				await expect(session.command('list', { path: '' })).rejects.toMatchObject({
					code: 'invalid-protocol',
				});
				await expect(session.read('objects/other', 8)).rejects.toThrow();
				await session.close();
				expect(await h.child.exited).not.toBeNull();
				expect(readFileSync(log, 'utf8')).toBe('1\n');
			} finally {
				await session.close();
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
	test('idle output is rejected before another request is sent', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'heed-smb-idle-'));
		const log = join(directory, 'requests');
		const h = helper(
			`const {appendFileSync}=require('node:fs');let b='';for await(const x of Bun.stdin.stream()){b+=Buffer.from(x).toString();for(;;){const n=b.indexOf('\\n');if(n<0)break;const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(!r.id){console.log(JSON.stringify({ok:true,ready:true,checkpointed:false}));continue;}appendFileSync(${JSON.stringify(log)},r.id+'\\n');const correlation=r.nonce?{nonce:r.nonce}:{};console.log(JSON.stringify({id:r.id,...correlation,ok:true,value:null}));if(r.id===1)setTimeout(()=>console.log(JSON.stringify({id:2,...correlation,ok:true,value:'unsolicited'})),10);}}`,
		);
		const session = await new PythonDirectSmbNative({ runner: h.runner }).open(
			binding,
			credentials,
			context,
		);
		try {
			await session.command('list', { path: '' });
			await Bun.sleep(60);
			await expect(session.command('list', { path: '' })).rejects.toThrow();
			await session.close();
			expect(await h.child.exited).not.toBeNull();
			expect(readFileSync(log, 'utf8')).toBe('1\n');
		} finally {
			await session.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test('each real request has a fresh nonce and all frame types require it', async () => {
		const h = helper(
			`let b='',prior;for await(const x of Bun.stdin.stream()){b+=Buffer.from(x).toString();for(;;){const n=b.indexOf('\\n');if(n<0)break;const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(!r.id){console.log(JSON.stringify({ok:true,ready:true,checkpointed:false}));continue;}if(!/^[a-f0-9]{64}$/.test(r.nonce)||r.nonce===prior)process.exit(4);prior=r.nonce;console.log(JSON.stringify({id:r.id,nonce:r.nonce,progress:true}));if(r.action==='read'){await Bun.write(Bun.stdout,JSON.stringify({id:r.id,nonce:r.nonce,bytes:3})+'\\nabc');}console.log(JSON.stringify({id:r.id,nonce:r.nonce,ok:true,value:r.id}));}}`,
		);
		const session = await new PythonDirectSmbNative({ runner: h.runner }).open(
			binding,
			credentials,
			context,
		);
		try {
			expect(await session.command('list', { path: '' })).toBe(1);
			expect((await session.read('objects/abc', 3)).toString()).toBe('abc');
			expect(await session.command('list', { path: '' })).toBe(3);
		} finally {
			await session.close();
		}
		expect(await h.child.exited).not.toBeNull();
	});
	test('unknown or stale nonce cannot acknowledge an active request or yield its bytes', async () => {
		for (const type of ['progress', 'error', 'terminal', 'chunk']) {
			const h = helper(
				`let b='';for await(const x of Bun.stdin.stream()){b+=Buffer.from(x).toString();for(;;){const n=b.indexOf('\\n');if(n<0)break;const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(!r.id){console.log(JSON.stringify({ok:true,ready:true,checkpointed:false}));continue;}const value=${JSON.stringify(type)};const correlation={id:r.id,nonce:'0'.repeat(64)};const frame=value==='progress'?{...correlation,progress:true}:value==='error'?{...correlation,ok:false,error:'access-denied'}:value==='chunk'?{...correlation,bytes:3}:{...correlation,ok:true,value:null};await Bun.write(Bun.stdout,JSON.stringify(frame)+'\\n'+(value==='chunk'?'XYZ':''));}}`,
			);
			const session = await new PythonDirectSmbNative({ runner: h.runner }).open(
				binding,
				credentials,
				context,
			);
			try {
				await expect(session.read('objects/abc', 3)).rejects.toMatchObject({
					code: 'invalid-protocol',
				});
			} finally {
				await session.close();
			}
			expect(await h.child.exited).not.toBeNull();
		}
	});
	test('a prior nonce cannot acknowledge a later request when arrival races dispatch', async () => {
		const h = helper(
			`let b='',prior;for await(const x of Bun.stdin.stream()){b+=Buffer.from(x).toString();for(;;){const n=b.indexOf('\\n');if(n<0)break;const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(!r.id){console.log(JSON.stringify({ok:true,ready:true,checkpointed:false}));continue;}if(r.id===1){prior=r.nonce;console.log(JSON.stringify({id:r.id,nonce:r.nonce,ok:true,value:null}));}else await Bun.write(Bun.stdout,JSON.stringify({id:r.id,nonce:prior,bytes:3})+'\\nXYZ'+JSON.stringify({id:r.id,nonce:prior,ok:true,value:null})+'\\n');}}`,
		);
		const session = await new PythonDirectSmbNative({ runner: h.runner }).open(
			binding,
			credentials,
			context,
		);
		try {
			await session.command('list', { path: '' });
			await expect(session.read('objects/other', 3)).rejects.toMatchObject({
				code: 'invalid-protocol',
			});
		} finally {
			await session.close();
		}
		expect(await h.child.exited).not.toBeNull();
	});
	test('production refuses an unverified runtime', async () => {
		await expect(new PythonDirectSmbNative().probe(endpoint, credentials)).rejects.toMatchObject({
			code: 'runtime-unavailable',
		});
	});
});

test('native pending query uses credential-free bounded EOF startup and rejects malformed native hints',async()=>{
 const h=helper(`let data='';for await(const c of Bun.stdin.stream())data+=Buffer.from(c);const req=JSON.parse(data);if(req.action!=='pending'||req.credentials!==undefined||req.appDir!=='/private/tmp/heed-task1')process.exit(2);process.stdout.write(JSON.stringify({ok:true,value:[]})+'\\n');`);
 const native=new PythonDirectSmbNative({runner:h.runner});expect(typeof (native as any).pending).toBe('function');expect(await (native as any).pending(binding,context.appDir)).toEqual([]);
 const bad=helper(`for await(const c of Bun.stdin.stream()){}process.stdout.write(JSON.stringify({ok:true,value:[{operationId:'invalid',deviceId:'invalid',kind:'delete',recoverable:true,admissions:[]}]})+'\\n');`);await expect((new PythonDirectSmbNative({runner:bad.runner}) as any).pending(binding,context.appDir)).rejects.toThrow();
});
test('failed native startup reports its private stop receipt only after the helper is reaped',async()=>{
 const h=helper(`let data='';for await(const c of Bun.stdin.stream()){data+=Buffer.from(c);if(data.includes('\\n')){console.log(JSON.stringify({ok:false,error:'access-denied'}));break;}}`);
 let failure:any;try{await new PythonDirectSmbNative({runner:h.runner}).open(binding,credentials,context);}catch(error){failure=error;}
 expect(failure?.code).toBe('access-denied');expect(await h.child.exited).not.toBeNull();expect(failure?.guardianStopped).toBe(true);expect(Object.keys(failure)).not.toContain('guardianStopped');
});

test('unproved native reaping never produces a stopped receipt',async()=>{
 const h=helper(`let data='';for await(const c of Bun.stdin.stream()){data+=Buffer.from(c);if(data.includes('\\n')){console.log(JSON.stringify({ok:false,error:'access-denied'}));break;}}`);let proxy:any;const runner=()=>{const child=h.runner();proxy=new Proxy(child,{get(target,key){if(key==='exited')return new Promise(()=>{});const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});return proxy;};let failure:any;
 try{await new PythonDirectSmbNative({runner}).open(binding,credentials,context);}catch(error){failure=error;}finally{if(proxy)untrack(proxy);}
 expect(failure?.code).toBe('transaction-unavailable');expect(failure?.guardianStopped).toBeUndefined();expect(await h.child.exited).not.toBeNull();
},6000);

test('I4 oneshot post-start receipt rejection proves child reaping before private stopped evidence', async () => {
  const h = helper(
    `${start}console.log(JSON.stringify({ok:true,value:${JSON.stringify(probe)}}));`,
  );
  let failure: any;
  try {
    await new PythonDirectSmbNative({ runner: h.runner }).probe(
      { ...endpoint, requireEncryption: true },
      credentials,
    );
  } catch (error) {
    failure = error;
  }
  expect(failure.code).toBe('unsupported-security');
  expect(await h.child.exited).not.toBeNull();
  expect(failure.guardianStopped).toBe(true);
  expect(Object.keys(failure)).not.toContain('guardianStopped');
});
test('N1 arbitrary runner rejection carries no invented stop evidence or raw diagnostics', async () => {
  let error: any;
  try {
    await new PythonDirectSmbNative({
      runner: () => {
        throw Object.assign(Error('secret-never-log'), {
          code: 'runtime-unavailable',
        });
      },
    }).probe(endpoint, credentials);
  } catch (e) {
    error = e;
  }
  expect(error.code).toBe('runtime-unavailable');
  expect(error.guardianStopped).toBeUndefined();
  expect(error.message).not.toContain('secret-never-log');
});

test('I4 oneshot unproved child exit never returns stopped evidence for probe initialization or pending', async () => {
  for (const action of ['probe', 'initialize', 'pending']) {
    const value =
        action === 'pending'
          ? []
          : {
              ...probe,
              identity: { ...identity, rootId: '0000000000000011' },
              destinationId: binding.destinationId,
              destinationVersion: 3,
              empty: false,
            },
      h = helper(
        `for await(const c of Bun.stdin.stream()){}console.log(JSON.stringify({ok:true,value:${JSON.stringify(value)}}));`,
      );
    let proxy: any, failure: any;
    const runner = () => {
      const child = h.runner();
      proxy = new Proxy(child, {
        get(target, key) {
          if (key === 'exited') return new Promise(() => {});
          const v = Reflect.get(target, key);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      return proxy;
    };
    const native = new PythonDirectSmbNative({ runner, timeoutMs: 50 });
    try {
      if (action === 'probe') await native.probe(endpoint, credentials);
      else if (action === 'initialize')
        await native.initialize(
          endpoint,
          credentials,
          identity,
          binding.destinationId,
        );
      else await native.pending(binding, context.appDir);
    } catch (e) {
      failure = e;
    } finally {
      if (proxy) untrack(proxy);
    }
    expect(failure.code).toBe('transaction-unavailable');
    expect(failure.guardianStopped).toBeUndefined();
    expect(await h.child.exited).not.toBeNull();
  }
}, 10000);

test('I4 prelaunch validation and cancellation prove no helper while preserving cancellation identity', async () => {
  let launches = 0;
  const native = new PythonDirectSmbNative({
    runner: () => {
      launches++;
      throw Error('Unexpected helper');
    },
  });
  for (const action of ['probe', 'initialize', 'pending']) {
    let failure: any;
    try {
      if (action === 'probe')
        await native.probe(
          { ...endpoint, server: 'invalid/name' },
          credentials,
        );
      else if (action === 'initialize')
        await native.initialize(endpoint, credentials, identity, 'invalid');
      else await native.pending({ ...binding, id: 'invalid' }, context.appDir);
    } catch (error) {
      failure = error;
    }
    expect(failure.code).toBe('invalid-input');
    expect(failure.guardianStopped).toBe(true);
    expect(Object.keys(failure)).not.toContain('guardianStopped');
  }
  const controller = new AbortController(),
    reason = Error('Explicit cancellation');
  controller.abort(reason);
  let cancellation: any;
  try {
    await native.probe(endpoint, credentials, controller.signal);
  } catch (error) {
    cancellation = error;
  }
  expect(cancellation).toBe(reason);
  expect(cancellation.guardianStopped).toBe(true);
  expect(launches).toBe(0);
});

test('QA observer crosses only stdin and waits for owned guardian exit',async()=>{
 const h=helper(`let raw='';for await(const x of Bun.stdin.stream())raw+=Buffer.from(x);const r=JSON.parse(raw);if(r.action!=='qa-observe-parent'||process.argv.join(' ').includes('secret-never-log'))process.exit(2);console.log(JSON.stringify({ok:true,value:{identity:r.identity,ancestors:[],security:'signed',readOnly:false,namespaceSafe:true}}));`);
 const native=new PythonDirectSmbNative({runner:h.runner});const result=await native.acceptance({action:'qa-observe-parent',endpoint,credentials,identity}) as any;expect(result.identity).toEqual(identity);expect(await h.child.exited).toBe(0);expect(()=>process.kill(h.child.pid,0)).toThrow();
});
test('QA startup bounds refuse before launch and cancellation provides actual stop proof',async()=>{
 let launches=0;const native=new PythonDirectSmbNative({runner:()=>{launches++;throw Error('must not launch');}});
 await expect(native.acceptance({action:'qa-create-child',endpoint,credentials,binding,spec:{sentinel:'x'.repeat(65536)},workspace:{},selectedScope:'parent'})).rejects.toThrow();expect(launches).toBe(0);
 const h=helper(`process.on('SIGTERM',()=>{});for await(const x of Bun.stdin.stream()){};setInterval(()=>{},1000);`),controller=new AbortController();const pending=new PythonDirectSmbNative({runner:h.runner,timeoutMs:5000}).acceptance({action:'qa-observe-parent',endpoint,credentials,identity},controller.signal);const timer=setTimeout(()=>controller.abort(),100);
 try{let error:any;try{await pending;}catch(e){error=e;}expect(error?.guardianStopped).toBe(true);expect(()=>process.kill(h.child.pid,0)).toThrow();}finally{clearTimeout(timer);controller.abort();await pending.catch(()=>{});}
});
