import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';
import type { PendingRemoteTransaction, TransactionContext } from './portable-provider';

export interface DirectSmbEndpoint {
	server: string;
	port: number;
	share: string;
	folder: string;
	requireEncryption: boolean;
}
export interface DirectSmbCredentials {
	username: string;
	password: string;
	domain: string;
}
export interface DirectSmbIdentity {
	serverGuid: string;
	volumeSerial: string;
	volumeCreated: string;
	rootId: string;
	rootCreated: string;
}
export interface DirectSmbProbe {
	identity: DirectSmbIdentity;
	dialect: string;
	authentication: 'authenticated';
	security: 'signed' | 'encrypted';
	encrypted: boolean;
	readOnly: boolean;
	namespaceSafe: boolean;
	destinationId: string | null;
	destinationVersion: 3 | null;
	empty: boolean;
}
export interface DirectSmbBinding {
	id: string;
	name: string;
	endpoint: DirectSmbEndpoint;
	identity: DirectSmbIdentity;
	destinationId: string;
	destinationVersion: 3;
	connectionGeneration: string;
	credentialRef: string;
	readOnly: boolean;
	security: 'signed' | 'encrypted';
}
export interface DirectSmbSession {
	command(action: string, value?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
	read(path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>;
	stream(path: string, maxBytes: number, signal?: AbortSignal): AsyncIterable<Uint8Array>;
	write(
		path: string,
		bytes: number,
		sha256: string,
		source: AsyncIterable<Uint8Array>,
		signal?: AbortSignal,
	): Promise<void>;
	close(): Promise<void>;
}
export type DirectSmbTransactionContext = TransactionContext & { appDir: string };
export interface DirectSmbNative {
 pending(binding:DirectSmbBinding,appDir:string,signal?:AbortSignal):Promise<PendingRemoteTransaction[]>;
	probe(
		endpoint: DirectSmbEndpoint,
		credentials: DirectSmbCredentials,
		signal?: AbortSignal,
	): Promise<DirectSmbProbe>;
	initialize(
		endpoint: DirectSmbEndpoint,
		credentials: DirectSmbCredentials,
		expectedIdentity: DirectSmbIdentity,
		destinationId: string,
		signal?: AbortSignal,
	): Promise<DirectSmbProbe>;
	open(
		binding: DirectSmbBinding,
		credentials: DirectSmbCredentials,
		context: DirectSmbTransactionContext,
		signal?: AbortSignal,
	): Promise<DirectSmbSession>;
}
export const DIRECT_SMB_CODES = new Set([
	'invalid-input',
	'invalid-protocol',
	'transport-unavailable',
	'runtime-unavailable',
	'unsupported-security',
	'unsupported-identity',
	'identity-changed',
	'unsupported-namespace',
	'unsupported-coordination',
	'access-denied',
	'read-only',
	'destination-exists',
	'unsupported-destination',
	'bounds-exceeded',
	'destination-busy',
	'recovery-required',
	'canonical-collision-noeffect',
	'canonical-admission-collision',
	'transaction-unavailable',
]);
export function directSmbError(code = 'transport-unavailable') {
	return Object.assign(new Error('Direct SMB operation unavailable.'), {
		code: DIRECT_SMB_CODES.has(code) ? code : 'transport-unavailable',
	});
}
export function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
	)
		throw directSmbError('invalid-input');
	return value as Record<string, unknown>;
}
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
export const DIRECT_SMB_UUID =
	/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function text(value: unknown, max: number, empty = false): string {
	if (
		typeof value !== 'string' ||
		value.length > max ||
		(!empty && !value.length) ||
		CONTROL.test(value) ||
		/[\uD800-\uDFFF]/u.test(value)
	)
		throw directSmbError('invalid-input');
	return value;
}
function component(value: string) {
	if (
		value !== value.normalize('NFC') ||
		/[<>|?:*\\/%]/.test(value) ||
		value === '.' ||
		value === '..' ||
		/[. ]$/.test(value) ||
		/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) ||
		Buffer.byteLength(value, 'utf16le') > 510
	)
		throw directSmbError('invalid-input');
	return text(value, 255);
}
export function validateDirectPath(value: unknown, empty = false): string {
	const path = text(value, 512, empty);
	if (!path && empty) return path;
	path.split('/').forEach(component);
	return path;
}
export function validateDirectEndpoint(value: unknown): DirectSmbEndpoint {
	const e = exactObject(value, ['server', 'port', 'share', 'folder', 'requireEncryption']);
	let host = text(e.server, 253);
	if (/[\s/:\\%@?#]/.test(host)) throw directSmbError('invalid-input');
	if (host.endsWith('.')) host = host.slice(0, -1);
	const reviewedHost = host.toLowerCase();
	host = domainToASCII(host.normalize('NFC')).toLowerCase();
	if (isIP(host) === 4 && host !== reviewedHost) throw directSmbError('invalid-input');
	if (
		!host ||
		host.length > 253 ||
		host.split('.').some((p) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))
	)
		throw directSmbError('invalid-input');
	if (/^[0-9.]+$/.test(host) && isIP(host) !== 4) throw directSmbError('invalid-input');
	if (
		!Number.isSafeInteger(e.port) ||
		Number(e.port) < 1 ||
		Number(e.port) > 65535 ||
		typeof e.requireEncryption !== 'boolean'
	)
		throw directSmbError('invalid-input');
	if (
		e.port !== 445 &&
		(!['localhost', '127.0.0.1'].includes(host) || Number(e.port) < 48000 || Number(e.port) > 48999)
	)
		throw directSmbError('invalid-input');
	const share = component(text(e.share, 255));
	const folder = validateDirectPath(e.folder, true);
	return {
		server: host,
		port: e.port as number,
		share,
		folder,
		requireEncryption: e.requireEncryption,
	};
}
export function validateDirectCredentials(value: unknown): DirectSmbCredentials {
	const c = exactObject(value, ['username', 'password', 'domain']);
	const username = text(c.username, 256);
	const password = text(c.password, 4096);
	const domain = text(c.domain, 253, true);
	if (
		username !== username.trim() ||
		/[\\/:]/.test(username) ||
		(domain && !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(domain))
	)
		throw directSmbError('invalid-input');
	return { username, password, domain };
}
export function validateDirectIdentity(value: unknown): DirectSmbIdentity {
	const keys = { serverGuid: 32, volumeSerial: 8, volumeCreated: 16, rootId: 16, rootCreated: 16 };
	const i = exactObject(value, Object.keys(keys));
	for (const [key, size] of Object.entries(keys)) {
		const v = i[key];
		if (
			typeof v !== 'string' ||
			!new RegExp(`^[a-f0-9]{${size}}$`).test(v) ||
			/^0+$/.test(v) ||
			/^f+$/.test(v) ||
			(key.endsWith('Created') && BigInt('0x' + v) >= 0x8000000000000000n)
		)
			throw directSmbError('unsupported-identity');
	}
	return structuredClone(i) as unknown as DirectSmbIdentity;
}
export function sameDirectIdentity(a: DirectSmbIdentity, b: DirectSmbIdentity) {
	return Object.keys(a).every(
		(k) => a[k as keyof DirectSmbIdentity] === b[k as keyof DirectSmbIdentity],
	);
}
export function validateDirectProbe(value: unknown): DirectSmbProbe {
	const p = exactObject(value, [
		'identity',
		'dialect',
		'authentication',
		'security',
		'encrypted',
		'readOnly',
		'namespaceSafe',
		'destinationId',
		'destinationVersion',
		'empty',
	]);
	const identity = validateDirectIdentity(p.identity);
	if (
		!['3.0', '3.0.2', '3.1.1'].includes(String(p.dialect)) ||
		p.authentication !== 'authenticated' ||
		!['signed', 'encrypted'].includes(String(p.security)) ||
		typeof p.encrypted !== 'boolean' ||
		(p.security === 'encrypted') !== p.encrypted ||
		typeof p.readOnly !== 'boolean' ||
		p.namespaceSafe !== true ||
		typeof p.empty !== 'boolean' ||
		!(
			(p.destinationId === null && p.destinationVersion === null) ||
			(typeof p.destinationId === 'string' &&
				DIRECT_SMB_UUID.test(p.destinationId) &&
				p.destinationVersion === 3 &&
				!p.empty)
		)
	)
		throw directSmbError();
	return { ...p, identity } as unknown as DirectSmbProbe;
}
export function validateDirectBinding(value: unknown): DirectSmbBinding {
	const b = exactObject(value, [
		'id',
		'name',
		'endpoint',
		'identity',
		'destinationId',
		'destinationVersion',
		'connectionGeneration',
		'credentialRef',
		'readOnly',
		'security',
	]);
	for (const k of ['id', 'destinationId', 'connectionGeneration', 'credentialRef'])
		if (typeof b[k] !== 'string' || !DIRECT_SMB_UUID.test(b[k] as string))
			throw directSmbError('invalid-input');
	text(b.name, 120);
	if (
		b.destinationVersion !== 3 ||
		typeof b.readOnly !== 'boolean' ||
		!['signed', 'encrypted'].includes(String(b.security))
	)
		throw directSmbError('invalid-input');
	return {
		...b,
		endpoint: validateDirectEndpoint(b.endpoint),
		identity: validateDirectIdentity(b.identity),
	} as unknown as DirectSmbBinding;
}
export function validateDirectContext(value: unknown): DirectSmbTransactionContext {
	const c = exactObject(value, ['operationId', 'deviceId', 'kind', 'appDir']);
	text(c.appDir, 4096);
	if (
		!(c.appDir as string).startsWith('/') ||
		(c.appDir as string).split('/').some((p) => p === '.' || p === '..')
	)
		throw directSmbError('invalid-input');
	if (
		typeof c.operationId !== 'string' ||
		!DIRECT_SMB_UUID.test(c.operationId) ||
		typeof c.deviceId !== 'string' ||
		!DIRECT_SMB_UUID.test(c.deviceId) ||
		!['read', 'publish', 'delete'].includes(String(c.kind))
	)
		throw directSmbError('invalid-input');
	return c as unknown as DirectSmbTransactionContext;
}
