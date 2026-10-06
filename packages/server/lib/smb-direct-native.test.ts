import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
			`let b='';for await(const x of Bun.stdin.stream()){b+=Buffer.from(x).toString();for(;;){const n=b.indexOf('\\n');if(n<0)break;const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(!r.id)console.log(JSON.stringify({ok:true,ready:true,checkpointed:false}));else console.log(JSON.stringify({id:r.id+1,bytes:1}));}}`,
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
			`let b=Buffer.alloc(0),started=false;for await(const x of Bun.stdin.stream()){b=Buffer.concat([b,Buffer.from(x)]);if(!started){const n=b.indexOf(10);if(n<0)continue;b=b.subarray(n+1);started=true;console.log(JSON.stringify({ok:true,ready:true,checkpointed:false}));}const n=b.indexOf(10);if(n>=0){const r=JSON.parse(b.subarray(0,n).toString());if(r.action==='write'&&b.length>=n+1+r.bytes){if(b.subarray(n+1).toString()!=='abc')process.exit(2);console.log(JSON.stringify({id:r.id,ok:true,value:null}));b=Buffer.alloc(0);}}}`,
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
			`let b='';for await(const x of Bun.stdin.stream()){b+=Buffer.from(x).toString();for(;;){const n=b.indexOf('\\n');if(n<0)break;const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);console.log(JSON.stringify(r.id?{id:r.id,bytes:131073}:{ok:true,ready:true,checkpointed:false}));}}`,
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
		await session.close();
		expect(await h.child.exited).not.toBeNull();
	});
	test('timeout rejects a stalled source and reaps its helper', async () => {
		const h = helper(
			`let b='';for await(const x of Bun.stdin.stream()){b+=Buffer.from(x).toString();for(;;){const n=b.indexOf('\\n');if(n<0)break;const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);console.log(JSON.stringify(r.id?{id:r.id,ok:true,value:null}:{ok:true,ready:true,checkpointed:false}));}}`,
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
	test('production refuses an unverified runtime', async () => {
		await expect(new PythonDirectSmbNative().probe(endpoint, credentials)).rejects.toMatchObject({
			code: 'runtime-unavailable',
		});
	});
});
