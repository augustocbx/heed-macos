import type { OriginalPrivateRootIdentity } from './local-store-io';
import {openNativeAuthoritySession,type NativeOwnedAuthorityRequest} from './qa/synchronization-device-authority';
import type {DirectSmbAcceptanceRequest} from './smb-direct-types';
import type {PendingRemoteTransaction} from './portable-provider';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { track, untrack, killTree } from './process';
import { spawnDirectSmbGuardian } from './smb-direct-runtime';
import {
	DIRECT_SMB_CODES,
	DIRECT_SMB_UUID,
	directSmbError,
	exactObject,
	sameDirectIdentity,
	validateDirectBinding,
	validateDirectContext,
	validateDirectCredentials,
	validateDirectEndpoint,
	validateDirectIdentity,
	validateDirectPath,
	validateDirectProbe,
} from './smb-direct-types';
import type {
	DirectSmbBinding,
	DirectSmbCredentials,
	DirectSmbEndpoint,
	DirectSmbIdentity,
	DirectSmbNative,
	DirectSmbProbe,
	DirectSmbSession,
	DirectSmbTransactionContext,
} from './smb-direct-types';
export type {
	DirectSmbBinding,
	DirectSmbCredentials,
	DirectSmbEndpoint,
	DirectSmbIdentity,
	DirectSmbNative,
	DirectSmbProbe,
	DirectSmbSession,
	DirectSmbTransactionContext,
} from './smb-direct-types';

const FRAME = 65536,
	RESULT = 2000000,
	CHUNK = 131072,
	MAX_BYTES = 8000000000000;
type Child = ReturnType<typeof Bun.spawn>;
export type DirectSmbRunner = (helper: string) => Child | Promise<Child>;
export interface DirectSmbNativeOptions {
	runner?: DirectSmbRunner;
	timeoutMs?: number;
}
function count(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_BYTES)
		throw directSmbError('invalid-input');
	return value;
}
function responseError(value: unknown) {
	const code =
		typeof value === 'string' && DIRECT_SMB_CODES.has(value) ? value : 'transport-unavailable';
	return directSmbError(code);
}
/** Private local receipt; never serialized as provider/API state. */
function stoppedFailure(error: unknown, preserve = false) {
  const failure =
    preserve && error instanceof Error
      ? error
      : responseError((error as { code?: unknown })?.code);
  Object.defineProperty(failure, 'guardianStopped', {
    value: true,
    enumerable: false,
  });
  return failure;
}
function rpcValue(action: string, value: Record<string, unknown>) {
	if (
		!/^[a-z][a-z-]{0,31}$/.test(action) ||
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		[
			'id',
			'nonce',
			'action',
			'credentials',
			'endpoint',
			'binding',
			'context',
			'appDir',
			'identity',
			'password',
			'username',
			'domain',
			'credentialRef',
		].some((k) => Object.hasOwn(value, k))
	)
		throw directSmbError('invalid-input');
	if (Object.hasOwn(value, 'path')) validateDirectPath(value.path, action === 'list');
	for (const k of ['bytes', 'maxBytes']) if (Object.hasOwn(value, k)) count(value[k]);
	if (
		Object.hasOwn(value, 'sha256') &&
		(typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256))
	)
		throw directSmbError('invalid-input');
	return value;
}
/** Validate duplicate keys as well as JSON syntax before interpreting a helper frame. */
export function decodeFrame(data: Uint8Array): Record<string, unknown> {
	try {
		const raw = new TextDecoder('utf-8', { fatal: true }).decode(data);
		if (raw.includes('\r')) throw directSmbError('invalid-protocol');
		let position = 0;
		function space() {
			while (/\s/.test(raw[position] ?? '') && position < raw.length) position++;
		}
		function string() {
			const start = position++;
			while (position < raw.length) {
				const c = raw[position++];
				if (c === '\\') {
					position++;
					continue;
				}
				if (c === '"') return JSON.parse(raw.slice(start, position)) as string;
			}
			throw directSmbError('invalid-protocol');
		}
		function value(depth = 0): void {
			if (depth > 64) throw directSmbError('invalid-protocol');
			space();
			if (raw[position] === '"') {
				string();
				return;
			}
			if (raw[position] === '{') {
				position++;
				space();
				const keys = new Set<string>();
				if (raw[position] === '}') {
					position++;
					return;
				}
				for (;;) {
					space();
					if (raw[position] !== '"') throw directSmbError('invalid-protocol');
					const k = string();
					if (keys.has(k)) throw directSmbError('invalid-protocol');
					keys.add(k);
					space();
					if (raw[position++] !== ':') throw directSmbError('invalid-protocol');
					value(depth + 1);
					space();
					const c = raw[position++];
					if (c === '}') return;
					if (c !== ',') throw directSmbError('invalid-protocol');
				}
			}
			if (raw[position] === '[') {
				position++;
				space();
				if (raw[position] === ']') {
					position++;
					return;
				}
				for (;;) {
					value(depth + 1);
					space();
					const c = raw[position++];
					if (c === ']') return;
					if (c !== ',') throw directSmbError('invalid-protocol');
				}
			}
			const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
				raw.slice(position),
			);
			if (!match) throw directSmbError('invalid-protocol');
			position += match[0].length;
		}
		value();
		space();
		if (position !== raw.length) throw directSmbError('invalid-protocol');
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
			throw directSmbError('invalid-protocol');
		return parsed;
	} catch {
		throw directSmbError('invalid-protocol');
	}
}

/** A single owned helper; startup credentials are never arguments or environment. */
class DirectRpcSession implements DirectSmbSession {
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private buffer = Buffer.alloc(0);
	private sequence = 0;
	private pendingRead?: ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>;
	private idle = false;
	private protocolFailure?: Error;
	private closed = false;
	private busy = false;
	private checkpointed = false;
	private completed = false;
	private finishing?: Promise<void>;
	private abort?: () => void;
	private startupSignal?: AbortSignal;
	constructor(
		private child: Child,
		private timeoutMs: number,
		signal?: AbortSignal,
	) {
		this.reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
		this.startupSignal = signal;
		this.abort = () => {
			void this.finish();
		};
		signal?.addEventListener('abort', this.abort, { once: true });
	}
	private armIdle() {
		this.idle = true;
		const pending = (this.pendingRead ??= this.reader.read());
		void pending.then(
			(result) => {
				if (this.idle && !this.closed && (result.done || result.value.length)) {
					this.protocolFailure = directSmbError('invalid-protocol');
					void this.finish().catch(() => {});
				}
			},
			() => {
				if (!this.closed) {
					this.protocolFailure = directSmbError('invalid-protocol');
					void this.finish().catch(() => {});
				}
			},
		);
	}
	private async take() {
		const pending = this.pendingRead ?? this.reader.read();
		const result = await pending;
		if (this.pendingRead === pending) this.pendingRead = undefined;
		if (result.done) throw directSmbError('invalid-protocol');
		if (
			result.value.length > RESULT + CHUNK ||
			this.buffer.length + result.value.length > RESULT + CHUNK
		)
			throw directSmbError('bounds-exceeded');
		this.buffer = Buffer.concat([this.buffer, result.value]);
	}
	private async frame(max = RESULT) {
		for (;;) {
			const n = this.buffer.indexOf(10);
			if (n >= 0) {
				if (n > max) throw directSmbError('bounds-exceeded');
				const line = this.buffer.subarray(0, n);
				this.buffer = this.buffer.subarray(n + 1);
				return decodeFrame(line);
			}
			if (this.buffer.length > max) throw directSmbError('bounds-exceeded');
			await this.take();
		}
	}
	private async bytes(length: number) {
		while (this.buffer.length < length) await this.take();
		const data = this.buffer.subarray(0, length);
		this.buffer = this.buffer.subarray(length);
		return data;
	}
	private async bounded<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		signal?.throwIfAborted();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		const stopped = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				void this.finish();
				reject(directSmbError('transport-unavailable'));
			}, this.timeoutMs);
			onAbort = () => {
				void this.finish();
				reject(directSmbError('transaction-unavailable'));
			};
			signal?.addEventListener('abort', onAbort, { once: true });
		});
		try {
			return await Promise.race([run(), stopped]);
		} catch (error) {
			await this.finish();
			signal?.throwIfAborted();
			throw responseError((error as { code?: unknown })?.code);
		} finally {
			clearTimeout(timeout);
			if (onAbort) signal?.removeEventListener('abort', onAbort);
		}
	}
	async startup<T=DirectSmbProbe>(request: Record<string, unknown>, transaction: boolean, signal?: AbortSignal, decode:(value:unknown)=>T=validateDirectProbe as (value:unknown)=>T) {
		return this.bounded(async () => {
			const data = Buffer.from(JSON.stringify(request));
			if (data.length > FRAME) throw directSmbError('bounds-exceeded');
			const sink = this.child.stdin as Bun.FileSink;
			await sink.write(data);
			await sink.write('\n');
			await sink.flush();
			if (!transaction) sink.end();
			const response = await this.frame(request.action==='pending'?RESULT:FRAME);
			if (response.ok === false) {
				exactObject(response, ['ok', 'error']);
				throw responseError(response.error);
			}
			if (transaction) {
				exactObject(
					response,
					response.completed === undefined
						? ['ok', 'ready', 'checkpointed']
						: ['ok', 'ready', 'checkpointed', 'completed'],
				);
				if (
					response.ok !== true ||
					response.ready !== true ||
					typeof response.checkpointed !== 'boolean' ||
					(response.completed !== undefined && response.completed !== true) ||
					this.buffer.length
				)
					throw directSmbError('invalid-protocol');
				this.checkpointed = response.checkpointed;
				this.completed = response.completed === true;
				if (!this.completed) this.armIdle();
				return undefined;
			}
			exactObject(response, ['ok', 'value']);
			if (response.ok !== true) throw directSmbError('invalid-protocol');
			const result = decode(response.value);
			while (true) {
				const next = await this.reader.read();
				if (next.done) break;
				if (next.value.length) throw directSmbError('invalid-protocol');
			}
			if (this.buffer.length || (await this.child.exited) !== 0)
				throw directSmbError('invalid-protocol');
			return result;
		}, signal);
	}
	private async *rpc(
		action: string,
		value: Record<string, unknown> = {},
		source?: AsyncIterable<Uint8Array>,
		signal?: AbortSignal,
	): AsyncGenerator<Uint8Array, unknown> {
		if (this.protocolFailure) throw this.protocolFailure;
		if (this.closed || this.completed) throw directSmbError('transaction-unavailable');
		if (this.busy) throw directSmbError('destination-busy');
		signal?.throwIfAborted();
		rpcValue(action, value);
		const nonce = randomBytes(32).toString('hex');
		const request = Buffer.from(JSON.stringify({ id: this.sequence + 1, nonce, action, ...value }));
		if (request.length > FRAME) throw directSmbError('bounds-exceeded');
		this.busy = true;
		const id = ++this.sequence;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stop!: (error: Error) => void;
		const stopped = new Promise<never>((_, reject) => {
			stop = reject;
		});
		stopped.catch(() => {});
		const abort = () => {
			void this.finish();
			stop(directSmbError('transaction-unavailable'));
		};
		signal?.addEventListener('abort', abort, { once: true });
		let sending: Promise<void> | undefined;
		try {
			// Let an already-settled owned idle read report its violation before
			// dispatch. A later arrival must still prove the fresh request nonce.
			await Promise.resolve();
			if (this.protocolFailure) throw this.protocolFailure;
			if (this.buffer.length) throw directSmbError('invalid-protocol');
			if (this.closed) throw directSmbError('transaction-unavailable');
			this.idle = false;
			timer = setTimeout(abort, this.timeoutMs);
			if (
				[
					'write',
					'write-deletion',
					'write-fence',
					'write-pending',
					'retire-pending',
					'remove-exact',
				].includes(action)
			)
				this.checkpointed = false;
			const sink = this.child.stdin as Bun.FileSink;
			await sink.write(request);
			await sink.write('\n');
			await sink.flush();
			sending = (async () => {
				if (!source) return;
				const hash = createHash('sha256');
				let size = 0;
				for await (const chunk of source) {
					signal?.throwIfAborted();
					if (this.closed || !(chunk instanceof Uint8Array))
						throw directSmbError('transaction-unavailable');
					size += chunk.length;
					if (size > Number(value.bytes)) throw directSmbError('bounds-exceeded');
					hash.update(chunk);
					for (let offset = 0; offset < chunk.length; offset += CHUNK) {
						await sink.write(chunk.subarray(offset, offset + CHUNK));
						await sink.flush();
					}
				}
				if (size !== value.bytes || hash.digest('hex') !== value.sha256)
					throw directSmbError('invalid-input');
			})().catch((error) => {
				void this.finish();
				throw error;
			});
			sending.catch(() => {});
			let received = 0;
			for (;;) {
				const r = await Promise.race([this.frame(), stopped]);
				signal?.throwIfAborted();
				if (r.id !== id || r.nonce !== nonce) throw directSmbError('invalid-protocol');
				if (r.progress === true) {
					exactObject(r, ['id', 'nonce', 'progress']);
					continue;
				}
				if (r.ok === false) {
					exactObject(r, ['id', 'nonce', 'ok', 'error']);
					throw responseError(r.error);
				}
				if (Object.hasOwn(r, 'bytes')) {
					exactObject(r, ['id', 'nonce', 'bytes']);
					if (
						!source &&
						action === 'read' &&
						typeof r.bytes === 'number' &&
						Number.isSafeInteger(r.bytes) &&
						r.bytes > 0 &&
						r.bytes <= CHUNK
					) {
						received += r.bytes;
						if (received > Number(value.maxBytes)) throw directSmbError('bounds-exceeded');
						yield await Promise.race([this.bytes(r.bytes), stopped]);
						continue;
					}
					throw directSmbError('invalid-protocol');
				}
				exactObject(r, ['id', 'nonce', 'ok', 'value']);
				if (r.ok !== true) throw directSmbError('invalid-protocol');
				if (this.buffer.length) throw directSmbError('invalid-protocol');
				await Promise.race([sending!, stopped]);
				if (this.buffer.length) throw directSmbError('invalid-protocol');
				this.armIdle();
				if (action === 'checkpoint') this.checkpointed = true;
				return r.value;
			}
		} catch (error) {
			await this.finish();
			signal?.throwIfAborted();
			throw responseError((error as { code?: unknown })?.code);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
			this.busy = false;
		}
	}
	async command(action: string, value: Record<string, unknown> = {}, signal?: AbortSignal) {
		if (this.completed && ['close', 'checkpoint'].includes(action)) return;
		const iterator = this.rpc(action, value, undefined, signal);
		for (;;) {
			const next = await iterator.next();
			if (next.done) return next.value;
			throw directSmbError('invalid-protocol');
		}
	}
	async *stream(path: string, maxBytes: number, signal?: AbortSignal) {
		validateDirectPath(path);
		count(maxBytes);
		const iterator = this.rpc('read', { path, maxBytes }, undefined, signal);
		let completed = false;
		try {
			for (;;) {
				const next = await iterator.next();
				if (next.done) {
					completed = true;
					return;
				}
				yield next.value;
			}
		} finally {
			if (!completed) await this.finish();
			await iterator.return(undefined);
		}
	}
	async read(path: string, maxBytes: number, signal?: AbortSignal) {
		if (count(maxBytes) > 16 * 1024 * 1024) throw directSmbError('bounds-exceeded');
		const chunks = [];
		for await (const data of this.stream(path, maxBytes, signal)) chunks.push(data);
		return Buffer.concat(chunks);
	}
	async write(
		path: string,
		bytes: number,
		sha256: string,
		source: AsyncIterable<Uint8Array>,
		signal?: AbortSignal,
	) {
		validateDirectPath(path);
		count(bytes);
		if (!/^[a-f0-9]{64}$/.test(sha256)) throw directSmbError('invalid-input');
		for await (const _ of this.rpc('write', { path, bytes, sha256 }, source, signal))
			throw directSmbError('invalid-protocol');
	}
	private finish() {
		return (this.finishing ??= this.finishOnce());
	}
	private async finishOnce() {
		let reaped = false;
		this.closed = true;
		try {
			(this.child.stdin as Bun.FileSink).end();
		} catch {}
		killTree(this.child);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.child.exited,
				new Promise<void>((resolve) => {
					timer = setTimeout(() => {
						killTree(this.child, 'SIGKILL');
						resolve();
					}, 1500);
				}),
			]);
			clearTimeout(timer);
			let hardTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					this.child.exited,
					new Promise<never>((_, reject) => {
						hardTimer = setTimeout(() => reject(directSmbError('transaction-unavailable')), 1500);
					}),
				]);
				reaped = true;
			} finally {
				clearTimeout(hardTimer);
			}
		} finally {
			clearTimeout(timer);
			if (this.abort) this.startupSignal?.removeEventListener('abort', this.abort);
			if (reaped) untrack(this.child);
			try {
				await this.reader.cancel();
			} catch {}
			try {
				this.reader.releaseLock();
			} catch {}
		}
	}
	async close() {
		if (this.closed) return this.finish();
		if (this.checkpointed && !this.busy && !this.completed) {
			try {
				await this.command('close');
			} finally {
				await this.finish();
			}
		} else await this.finish();
	}
}

export class PythonDirectSmbNative implements DirectSmbNative {
	private helper = fileURLToPath(new URL('../native/smb-direct/guardian.py', import.meta.url));
	private runner: DirectSmbRunner;
	private timeoutMs: number;
	constructor(options: DirectSmbNativeOptions = {}) {
		this.runner = options.runner ?? spawnDirectSmbGuardian;
		this.timeoutMs = options.timeoutMs ?? 120000;
		if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 1800000)
			throw directSmbError('invalid-input');
	}
	private async start<T = DirectSmbProbe>(
		request: Record<string, unknown>,
		transaction: boolean,
		signal?: AbortSignal,
		decode?: (value: unknown) => T,
        timeoutMs=this.timeoutMs,
	) {
		if (signal?.aborted) throw stoppedFailure(signal.reason, true);
		let child: Child;
		try {
			child = track(await this.runner(this.helper));
		} catch (error) {
			// A runner can own preflight helpers; rejection alone proves no stop.
			const witness =
				error instanceof Error &&
				Object.getOwnPropertyDescriptor(error, 'guardianStopped');
			if (witness && witness.value === true && witness.enumerable === false)
				throw stoppedFailure(error, signal?.aborted && error === signal.reason);
			throw responseError((error as { code?: unknown })?.code);
		}
		const session = new DirectRpcSession(child, timeoutMs, signal);
		try {
			const probe = await session.startup<T>(
				{ protocol: 1, ...request },
				transaction,
				signal,
				decode,
			);
			return { session, probe };
		} catch (error) {
			// If stopping cannot prove reaping, close throws and no stop receipt exists.
			await session.close();
			throw stoppedFailure(error, signal?.aborted && error === signal.reason);
		}
	}
	private prelaunch<T>(run: () => T): T {
		try {
			return run();
		} catch (error) {
			throw stoppedFailure(error);
		}
	}
	private async oneshot<T>(
		session: DirectSmbSession,
		run: () => T,
	): Promise<T> {
		let result: T;
		try {
			result = run();
		} catch (error) {
			await session.close();
			throw stoppedFailure(error);
		}
		await session.close();
		return result;
	}
 async openAcceptanceAuthority(request:NativeOwnedAuthorityRequest,signal?:AbortSignal){
  const keys=['action','binding','spec','workspace','selectedScope','role','endpoint','credentials'];
  if(request.action!=='qa-open-owned-authority'||Object.keys(request).sort().join(',')!==keys.sort().join(',')||!['creator','participant'].includes(request.role)||request.selectedScope!==(request.role==='creator'?'parent':'child')||Buffer.byteLength(JSON.stringify(request))>65535)throw directSmbError('invalid-input');
  validateDirectBinding(request.binding);validateDirectEndpoint(request.endpoint);validateDirectCredentials(request.credentials);
  return openNativeAuthoritySession(()=>this.runner(this.helper),{protocol:1,...request} as unknown as Record<string,unknown>,signal);
 }
    async acceptance(request:DirectSmbAcceptanceRequest,signal?:AbortSignal):Promise<unknown>{
        this.prelaunch(()=>{
            const keys=request.action==='qa-observe-parent'?['action','endpoint','credentials','identity']:request.action==='qa-create-child'?['action','endpoint','credentials','binding','spec','workspace','selectedScope']:request.action==='qa-join-child'?['action','endpoint','credentials','binding','spec','workspace','selectedScope','evidence']:[];
            exactObject(request,keys);validateDirectEndpoint(request.endpoint);validateDirectCredentials(request.credentials);
            if(!keys.length||Buffer.byteLength(JSON.stringify({protocol:1,...request}))>65535)throw directSmbError('invalid-input');
            if(request.action==='qa-observe-parent')validateDirectIdentity(request.identity);
            else validateDirectBinding(request.binding);
        });
        const {session,probe}=await this.start<unknown>(request as unknown as Record<string,unknown>,false,signal,value=>{
            if(Buffer.byteLength(JSON.stringify(value))>150000)throw directSmbError('invalid-protocol');return value;
        },Math.min(this.timeoutMs,request.action==='qa-observe-parent'?30000:120000));
        return this.oneshot(session,()=>probe);
    }

	async pending(
		binding: DirectSmbBinding,
		appDir: string,
		signal?: AbortSignal,
		originalPrivateRoot?: OriginalPrivateRootIdentity,
	): Promise<PendingRemoteTransaction[]> {
		const b = this.prelaunch(() => {
			const b = validateDirectBinding(binding);
			validateDirectContext({
				operationId: b.id,
				deviceId: b.id,
				kind: 'read',
				appDir,
				...(originalPrivateRoot === undefined ? {} : { originalPrivateRoot }),
			});
			return b;
		});
		const { session, probe } = await this.start<PendingRemoteTransaction[]>(
			{ action: 'pending', binding: b, appDir, ...(originalPrivateRoot === undefined ? {} : { originalPrivateRoot }) },
			false,
			signal,
			validateDirectPending,
		);
		return this.oneshot(session, () => probe!);
	}

	async probe(
		endpoint: DirectSmbEndpoint,
		credentials: DirectSmbCredentials,
		signal?: AbortSignal,
	): Promise<DirectSmbProbe> {
		const { e, c } = this.prelaunch(() => ({
			e: validateDirectEndpoint(endpoint),
			c: validateDirectCredentials(credentials),
		}));
		const { session, probe } = await this.start(
			{ action: 'probe', endpoint: e, credentials: c },
			false,
			signal,
		);
		return this.oneshot(session, () => {
			if (e.requireEncryption && !probe!.encrypted)
				throw directSmbError('unsupported-security');
			return probe!;
		});
	}
	async initialize(
		endpoint: DirectSmbEndpoint,
		credentials: DirectSmbCredentials,
		expectedIdentity: DirectSmbIdentity,
		destinationId: string,
		signal?: AbortSignal,
	): Promise<DirectSmbProbe> {
		const { e, c } = this.prelaunch(() => ({
			e: validateDirectEndpoint(endpoint),
			c: validateDirectCredentials(credentials),
		}));
		const identity = this.prelaunch(() => {
			const identity = validateDirectIdentity(expectedIdentity);
			if (!DIRECT_SMB_UUID.test(destinationId))
				throw directSmbError('invalid-input');
			return identity;
		});
		const { session, probe } = await this.start(
			{
				action: 'initialize',
				endpoint: e,
				credentials: c,
				identity,
				destinationId,
			},
			false,
			signal,
		);
		return this.oneshot(session, () => {
			if (
				!sameDirectIdentity(identity, probe!.identity) ||
				probe!.destinationId !== destinationId ||
				probe!.destinationVersion !== 3 ||
				probe!.empty ||
				(e.requireEncryption && !probe!.encrypted)
			)
				throw directSmbError('identity-changed');
			return probe!;
		});
	}
	async open(
		binding: DirectSmbBinding,
		credentials: DirectSmbCredentials,
		context: DirectSmbTransactionContext,
		signal?: AbortSignal,
	): Promise<DirectSmbSession> {
		const { b, c, appDir, originalPrivateRoot, operation } = (() => {
			try {
				signal?.throwIfAborted();
				const b = validateDirectBinding(binding),
					c = validateDirectCredentials(credentials);
				const { appDir, originalPrivateRoot, ...operation } = validateDirectContext(context);
				return { b, c, appDir, originalPrivateRoot, operation };
			} catch (error) {
				throw stoppedFailure(error, signal?.aborted && error === signal.reason);
			}
		})();
		const { session } = await this.start(
			{
				action: 'transaction',
				endpoint: b.endpoint,
				credentials: c,
				binding: b,
				context: operation,
				appDir,
				...(originalPrivateRoot === undefined ? {} : { originalPrivateRoot }),
			},
			true,
			signal,
		);
		return session;
	}
}

/** Native validates physical journal authority; this validates only its bounded public hints. */
export function validateDirectPending(value:unknown):PendingRemoteTransaction[] {
 if(!Array.isArray(value)||value.length>10000||Buffer.byteLength(JSON.stringify(value))>1900000)throw directSmbError('bounds-exceeded');
 let admissions=0;const operations=new Set<string>();
 for(const raw of value){const keys=['operationId','deviceId','kind','recoverable','admissions'];if(raw&&Object.hasOwn(raw,'releaseOnly'))keys.push('releaseOnly');if(raw&&Object.hasOwn(raw,'blockedReason'))keys.push('blockedReason');const job=exactObject(raw,keys);
  if(!DIRECT_SMB_UUID.test(String(job.operationId))||!DIRECT_SMB_UUID.test(String(job.deviceId))||operations.has(String(job.operationId))||!['read','publish','delete'].includes(String(job.kind))||typeof job.recoverable!=='boolean'||job.releaseOnly!==undefined&&job.releaseOnly!==true||job.blockedReason!==undefined&&(typeof job.blockedReason!=='string'||job.blockedReason.length>512)||!Array.isArray(job.admissions))throw directSmbError('invalid-protocol');operations.add(String(job.operationId));
  for(const admission of job.admissions){if(++admissions>10000)throw directSmbError('bounds-exceeded');const a=exactObject(admission,['meetingId','revisionId','manifestHash']);if(!DIRECT_SMB_UUID.test(String(a.meetingId))||!DIRECT_SMB_UUID.test(String(a.revisionId))||typeof a.manifestHash!=='string'||!/^[a-f0-9]{64}$/.test(a.manifestHash))throw directSmbError('invalid-protocol');}
 }return structuredClone(value) as PendingRemoteTransaction[];
}
