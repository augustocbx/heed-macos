import { beforeEach, describe, expect, it, vi } from 'vitest';
import { directSmbApi, DirectSmbApiError } from './smb-direct';
const endpoint = { server: 'files.example', port: 445, share: 'meetings', folder: '', requireEncryption: false };
const capabilities = { read: true, write: true, authentication: 'authenticated', dialect: '3.1.1', security: 'signed', encrypted: false, durability: 'share-readback', remoteDeletion: true };
const preview = { receipt: 'receipt', expiresAt: Date.now() + 300000, endpoint, destinationId: null, needsCreation: true, capabilities };
const snapshot = { connections: [], recoveryRequired: false, syncing: false };
const network = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', network); network.mockReset(); });
describe('direct SMB network contract', () => {
 it('posts credentials only in the explicit test body with no-store and abort signal', async () => {
  network.mockResolvedValue(Response.json(preview));
  const controller = new AbortController();
  expect(await directSmbApi.test(endpoint, { username: 'account', domain: 'domain', password: 'secret' }, controller.signal)).toEqual(preview);
  expect(network).toHaveBeenCalledWith('/api/smb/direct', expect.objectContaining({ method: 'POST', cache: 'no-store', signal: controller.signal, body: JSON.stringify({ action: 'test', endpoint, credentials: { username: 'account', domain: 'domain', password: 'secret' } }) }));
 });
 it('sends paired replacement generation and exact reviewed action payloads', async () => {
  network.mockImplementation(() => Promise.resolve(Response.json(snapshot)));
  await directSmbApi.connect('Office', 'receipt', true, { id: 'c', generation: 'g' });
  await directSmbApi.rename('c', 'g', 'New'); await directSmbApi.enable('c', 'g', false);
  await directSmbApi.disconnect('c', 'g'); await directSmbApi.sync('c', 'g'); await directSmbApi.status();
  expect(network.mock.calls.map(([, init]) => init.body && JSON.parse(init.body))).toEqual([
   { action: 'connect', name: 'Office', receipt: 'receipt', create: true, connectionId: 'c', generation: 'g' },
   { action: 'rename', id: 'c', generation: 'g', name: 'New' }, { action: 'enable', id: 'c', generation: 'g', enabled: false },
   { action: 'disconnect', id: 'c', generation: 'g' }, { action: 'sync', id: 'c', generation: 'g' }, undefined,
  ]);
 });
 it.each([400,403,409,503])('preserves body code at HTTP %i while discarding private raw diagnostics', async status => {
  network.mockResolvedValue(Response.json({ error: 'secret account /private/path', code: 'read-only' }, { status }));
  const failure = await directSmbApi.status().catch(e => e);
  expect(failure).toBeInstanceOf(DirectSmbApiError); expect(failure.code).toBe('read-only'); expect(failure.status).toBe(status);
  expect(String(failure)).not.toContain('secret'); expect(String(failure)).not.toContain('/private/path');
 });
 it.each([
  { capabilities: { ...capabilities, write: false } },
  { capabilities: { ...capabilities, security: 'signed', encrypted: true } },
  { capabilities: { ...capabilities, security: ['signed'] } },
  { capabilities: { ...capabilities, dialect: '2.1' } },
  { capabilities: { ...capabilities, remoteDeletion: "unsupported" } },
  { capabilities: { ...capabilities, remoteDeletion: false } },
  { endpoint: { ...endpoint, share: 'other' } },
  { destinationId: 'existing', needsCreation: true },
  { credentialRef: 'private-reference' },
 ])('refuses contradictory or private test preview %j', async changes => {
  network.mockResolvedValue(Response.json({ ...preview, ...changes }));
  await expect(directSmbApi.test(endpoint, { username: 'account', password: 'secret', domain: '' })).rejects.toMatchObject({ code: 'invalid-preview' });
 });
 it('refuses missing required encryption', async () => {
  network.mockResolvedValue(Response.json({ ...preview, endpoint: { ...endpoint, requireEncryption: true } }));
  await expect(directSmbApi.test({ ...endpoint, requireEncryption: true }, { username: 'account', password: 'secret', domain: '' })).rejects.toMatchObject({ code: 'invalid-preview' });
 });
 it.each(['127.1','0x7f000001','2130706433'])('refuses loopback aliases %s instead of broadening alternate-port policy',async server=>{
  network.mockResolvedValue(Response.json(preview));
  await expect(directSmbApi.test({...endpoint,server,port:48001},{username:'account',password:'secret',domain:''})).rejects.toMatchObject({code:'invalid-input'});
  expect(network).not.toHaveBeenCalled();
 });

 it.each([['localhost',48000],['127.0.0.1',48999]] as const)('accepts explicit loopback %s at allowed boundary port %i',async(server,port)=>{
  const localEndpoint={...endpoint,server,port};network.mockResolvedValue(Response.json({...preview,endpoint:localEndpoint}));
  expect(await directSmbApi.test(localEndpoint,{username:'account',password:'secret',domain:''})).toMatchObject({endpoint:localEndpoint});
  expect(network).toHaveBeenCalledOnce();
 });

});
