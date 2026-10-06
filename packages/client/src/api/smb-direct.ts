import { buildUrl } from './client';

export interface DirectSmbEndpoint {
 server: string;
 port: number;
 share: string;
 folder: string;
 requireEncryption: boolean;
}
export interface DirectSmbCredentials { username: string; password: string; domain: string }
export interface DirectSmbCapabilities {
 read: true;
 write: true;
 authentication: 'authenticated';
 dialect: string;
 security: 'signed' | 'encrypted';
 encrypted: boolean;
 durability: 'share-readback';
 remoteDeletion: boolean;
}
export interface DirectSmbConnection {
 id: string;
 generation: string;
 name: string;
 endpoint: DirectSmbEndpoint;
 destinationId: string;
 enabled: boolean;
 capabilities: DirectSmbCapabilities;
 progress: { pending: number; nextRetryAt: number | null; lastSync: number | null; imported: number; skipped: number };
 error: null | { code: string; message: string };
}
export interface DirectSmbSnapshot { recoveryRequired: boolean; syncing: boolean; connections: DirectSmbConnection[] }
export interface DirectSmbReview {
 receipt: string;
 expiresAt: number;
 endpoint: DirectSmbEndpoint;
 destinationId: string | null;
 needsCreation: boolean;
 capabilities: DirectSmbCapabilities;
}
export interface DirectSmbTarget { id: string; generation: string }
/** Error text is deliberately static; only structured codes reach the localized interface. */
export class DirectSmbApiError extends Error {
 constructor(public code: string, public status?: number) {
  super('Direct SMB operation unavailable.');
  this.name = 'DirectSmbApiError';
 }
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
 return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function endpointValid(value: unknown): value is DirectSmbEndpoint {
 if (!exact(value, ['server','port','share','folder','requireEncryption'])) return false;
 return typeof value.server === 'string' && typeof value.share === 'string' && typeof value.folder === 'string' && Number.isSafeInteger(value.port) && typeof value.requireEncryption === 'boolean';
}
/** Direct v3 currently requires coordination and remote deletion support; there is no direct read-only mode. */
function capabilitiesValid(value: unknown, endpoint: DirectSmbEndpoint): value is DirectSmbCapabilities {
 if (!exact(value, ['read','write','authentication','dialect','security','encrypted','durability','remoteDeletion'])) return false;
 return value.read === true && value.write === true && value.authentication === 'authenticated' && typeof value.dialect === 'string' && ['3.0','3.0.2','3.1.1'].includes(value.dialect) && typeof value.security === 'string' && ['signed','encrypted'].includes(value.security) && typeof value.encrypted === 'boolean' && (value.security === 'encrypted') === value.encrypted && (!endpoint.requireEncryption || value.encrypted) && value.durability === 'share-readback' && value.remoteDeletion === true;
}
/** Normalize only the public server name; the server remains authoritative for namespace/account validation. */
export function reviewedEndpoint(value: DirectSmbEndpoint): DirectSmbEndpoint {
 let server: string;
 try {
  if (!value.server || /[\s/:\\%@?#]/.test(value.server)) throw new Error();
  const requestedHost = value.server.normalize('NFC').toLowerCase().replace(/\.$/, '');
  server = new URL(`http://${requestedHost}`).hostname.toLowerCase().replace(/\.$/, '');
  if (/^[0-9]+(?:\.[0-9]+){3}$/.test(server) && server !== requestedHost) throw new Error();
  if (!server || !value.share || !Number.isSafeInteger(value.port) || (value.port !== 445 && (!['localhost','127.0.0.1'].includes(server) || value.port < 48000 || value.port > 48999))) throw new Error();
 } catch { throw new DirectSmbApiError('invalid-input'); }
 return { ...value, server };
}
function preview(value: unknown, endpoint: DirectSmbEndpoint): DirectSmbReview {
 if (!exact(value, ['receipt','expiresAt','endpoint','destinationId','needsCreation','capabilities']) || !endpointValid(value.endpoint)) throw new DirectSmbApiError('invalid-preview');
 const returnedEndpoint = value.endpoint;
 const sameEndpoint = Object.keys(endpoint).every(key => endpoint[key as keyof DirectSmbEndpoint] === returnedEndpoint[key as keyof DirectSmbEndpoint]);
 const destinationValid = (value.destinationId === null && value.needsCreation === true) || (typeof value.destinationId === 'string' && !!value.destinationId && value.needsCreation === false);
 if (!sameEndpoint || typeof value.receipt !== 'string' || !value.receipt || !Number.isSafeInteger(value.expiresAt) || !destinationValid || !capabilitiesValid(value.capabilities, endpoint)) throw new DirectSmbApiError('invalid-preview');
 return value as unknown as DirectSmbReview;
}
function snapshot(value: unknown): DirectSmbSnapshot {
 if (!exact(value, ['recoveryRequired','syncing','connections']) || typeof value.recoveryRequired !== 'boolean' || typeof value.syncing !== 'boolean' || !Array.isArray(value.connections)) throw new DirectSmbApiError('invalid-preview');
 for (const c of value.connections) {
  if (!exact(c, ['id','generation','name','endpoint','destinationId','enabled','capabilities','progress','error']) || !['id','generation','name','destinationId'].every(key => typeof c[key] === 'string' && !!c[key]) || !endpointValid(c.endpoint) || !capabilitiesValid(c.capabilities, c.endpoint) || typeof c.enabled !== 'boolean' || !exact(c.progress, ['pending','nextRetryAt','lastSync','imported','skipped'])) throw new DirectSmbApiError('invalid-preview');
  const progress = c.progress;
  if (!['pending','imported','skipped'].every(key => Number.isSafeInteger(progress[key]) && Number(progress[key]) >= 0) || !['nextRetryAt','lastSync'].every(key => progress[key] === null || Number.isFinite(progress[key])) || !(c.error === null || (exact(c.error, ['code','message']) && typeof c.error.code === 'string' && typeof c.error.message === 'string'))) throw new DirectSmbApiError('invalid-preview');
 }
 return value as unknown as DirectSmbSnapshot;
}
async function request(body?: unknown, signal?: AbortSignal): Promise<unknown> {
 let response: Response;
 try {
  response = await fetch(buildUrl('/api/smb/direct'), {
   method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal,
   ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
 } catch { throw new DirectSmbApiError('transport-unavailable'); }
 let value: unknown;
 try { value = await response.json(); } catch { throw new DirectSmbApiError(response.ok ? 'invalid-preview' : 'transport-unavailable', response.status); }
 if (!response.ok) {
  const code = value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' ? value.code : 'transport-unavailable';
  throw new DirectSmbApiError(code, response.status);
 }
 return value;
}
const control = async (body: unknown, signal?: AbortSignal) => snapshot(await request(body, signal));
export const directSmbApi = {
 status: async (signal?: AbortSignal) => snapshot(await request(undefined, signal)),
 test: async (endpoint: DirectSmbEndpoint, credentials: DirectSmbCredentials, signal?: AbortSignal) => {
  const reviewed = reviewedEndpoint(endpoint);
  return preview(await request({ action: 'test', endpoint: reviewed, credentials }, signal), reviewed);
 },
 connect: (name: string, receipt: string, create: boolean, target?: DirectSmbTarget, signal?: AbortSignal) => control({ action: 'connect', name, receipt, create, ...(target ? { connectionId: target.id, generation: target.generation } : {}) }, signal),
 rename: (id: string, generation: string, name: string, signal?: AbortSignal) => control({ action: 'rename', id, generation, name }, signal),
 enable: (id: string, generation: string, enabled: boolean, signal?: AbortSignal) => control({ action: 'enable', id, generation, enabled }, signal),
 disconnect: (id: string, generation: string, signal?: AbortSignal) => control({ action: 'disconnect', id, generation }, signal),
 sync: (id: string, generation: string, signal?: AbortSignal) => control({ action: 'sync', id, generation }, signal),
};
