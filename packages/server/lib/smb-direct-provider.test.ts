import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedQuota } from './managed-quota';
import { afterEach, test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DirectSmbBinding, DirectSmbNative, DirectSmbSession } from './smb-direct-types';
import { sha256 } from './portable-schema';
let Provider: any;
try {
    Provider = (await import('./smb-direct-provider')).DirectSmbProvider;
}
catch { }
const binding = (): DirectSmbBinding => ({ id: randomUUID(), name: 'Synthetic direct library', endpoint: { server: 'nas.local', port: 445, share: 'qa', folder: 'library', requireEncryption: false }, identity: { serverGuid: '0123456789abcdef0123456789abcdef', volumeSerial: '00000001', volumeCreated: '01db000000000002', rootId: '0000000000000002', rootCreated: '01db000000000001' }, destinationId: randomUUID(), destinationVersion: 3, connectionGeneration: randomUUID(), credentialRef: randomUUID(), readOnly: false, security: 'signed' });
function fixture(b = binding()) {
    const actions: string[] = [], opens: any[] = [], sources: Buffer[] = [];
    let credentials = 0;
    const session: DirectSmbSession = { command: async (action, value) => {
            actions.push(action);
            if (action === 'observation-digest')
                return '1'.repeat(64);
            if (action === 'inventory')
                return { commits: [], deletions: [], pending: [], complete: true };
            if (action === 'confirm')
                return 'remote-confirmed';
            if (action === 'remove-exact')
                return 'removed';
            return null;
        }, read: async () => Buffer.from('exact'), stream: async function* () { yield Buffer.from('exact'); }, write: async (_p, n, hash, source) => {
            for await (const c of source)
                sources.push(Buffer.from(c));
            if (Buffer.concat(sources).length !== n || sha256(Buffer.concat(sources)) !== hash)
                throw Error('Integrity');
        }, close: async () => { actions.push('close'); } };
    const native = { open: async (...args: any[]) => { opens.push(args); return session; }, pending: () => [] } as unknown as DirectSmbNative;
    const provider = () => new Provider(b, native, async () => { credentials++; return { username: 'qa', password: 'private-secret', domain: '' }; }, '/private/owned-app');
    return { b, provider, actions, opens, sources, credentials: () => credentials };
}
test('direct provider exposes only v3 whole-operation I/O and refuses legacy or read-only access before credentials', async () => {
    expect(typeof Provider).toBe('function');
    const f = fixture(), p = f.provider();
    await expect(p.read('commits/x.json', 64)).rejects.toThrow();
    expect(f.credentials()).toBe(0);
    expect(() => fixture({ ...binding(), destinationVersion: 2 } as any).provider()).toThrow();
    const ro = fixture({ ...binding(), readOnly: true });
    await expect(ro.provider().withTransaction({ operationId: randomUUID(), deviceId: randomUUID(), kind: 'read' }, async () => { })).rejects.toThrow();
    expect(ro.credentials()).toBe(0);
});
test('direct provider passes immutable original app directory and binding per operation and closes scoped session', async () => {
    expect(typeof Provider).toBe('function');
    const f = fixture(), p = await f.provider().initialize(), context = { operationId: randomUUID(), deviceId: randomUUID(), kind: 'read' };
    await p.withTransaction(context, async (tx: any) => { expect(await p.read('commits/x.json', 64)).toEqual(Buffer.from('exact')); expect((await tx.inventory()).complete).toBe(true); await tx.checkpoint(); });
    expect(f.opens[0][2]).toEqual({ ...context, appDir: '/private/owned-app' });
    expect(f.opens[0][0]).toEqual(f.b);
    expect(f.credentials()).toBe(1);
    expect(f.actions).toEqual(['inventory', 'checkpoint', 'close']);
    await expect(p.read('commits/x.json', 64)).rejects.toThrow();
});
test('direct provider reuses only its own nested operation, rejects conflicting authority and retains failed quota', async () => {
    expect(typeof Provider).toBe('function');
    const f = fixture(), reserved: string[] = [], released: string[] = [], p = new Provider(f.b, { open: async () => { throw Error('Native unavailable'); }, pending: () => [] } as any, async () => ({ username: 'qa', password: 'secret', domain: '' }), '/private/owned-app', { reserve: (id: string) => reserved.push(id), release: (id: string) => released.push(id) });
    await p.initialize();
    await expect(p.withTransaction({ operationId: randomUUID(), deviceId: randomUUID(), kind: 'publish' }, async () => { })).rejects.toThrow('Native');
    expect(reserved).toHaveLength(1);
    expect(released).toHaveLength(0);
    const good = await f.provider().initialize(), ctx = { operationId: randomUUID(), deviceId: randomUUID(), kind: 'publish' };
    await good.withTransaction(ctx, async () => { await expect(good.withTransaction({ ...ctx, deviceId: randomUUID() }, async () => { })).rejects.toThrow(); await good.withTransaction(ctx, async () => { }); });
    expect(f.opens).toHaveLength(1);
});
test('pending authority requires initialized native cache and refreshes after failed operations without credentials', async () => {
    expect(typeof Provider).toBe('function');
    const f = fixture();
    let queries = 0;
    const job = { operationId: randomUUID(), deviceId: randomUUID(), kind: 'delete', recoverable: false, admissions: [], blockedReason: 'Original owner required' };
    const native = { pending: async () => { queries++; return queries === 1 ? [] : [job]; }, open: async () => { throw Error('Original job retained'); } } as any;
    const p = new Provider(f.b, native, async () => ({ username: 'qa', password: 'secret', domain: '' }), '/private/owned-app');
    expect(() => p.pendingTransactions()).toThrow();
    await p.initialize();
    expect(p.pendingTransactions()).toEqual([]);
    await expect(p.withTransaction({ operationId: randomUUID(), deviceId: randomUUID(), kind: 'delete' }, async () => { })).rejects.toThrow('Original job');
    expect(p.pendingTransactions()).toEqual([job]);
});
test('publication after an early checkpoint retains quota until a final durable checkpoint', async () => {
    const f = fixture(), released: string[] = [], p = new Provider(f.b, { ...{ open: async () => ({ command: async () => null, write: async () => { }, close: async () => { }, read: async () => new Uint8Array(), stream: async function* () { } }) }, pending: async () => [] } as any, async () => ({ username: 'qa', password: 'secret', domain: '' }), '/private/owned-app', { reserve() { }, release: (id: string) => released.push(id) });
    await p.initialize();
    await p.withTransaction({ operationId: randomUUID(), deviceId: randomUUID(), kind: 'publish' }, async (tx: any) => { await tx.checkpoint(); await p.writeImmutable('commits/x.json', Buffer.from('changed')); });
    expect(released).toHaveLength(0);
});
test('failed local pending refresh preserves quota and refuses synchronous empty recovery hints', async () => {
    const f = fixture(), released: string[] = [], session = { command: async () => null, close: async () => { } };
    let queries = 0;
    const p = new Provider(f.b, { open: async () => session, pending: async () => {
            if (++queries > 1)
                throw Error('Pending query unavailable');
            return [];
        } } as any, async () => ({ username: 'qa', password: 'secret', domain: '' }), '/private/owned-app', { reserve() { }, release: (id: string) => released.push(id) });
    await p.initialize();
    await expect(p.withTransaction({ operationId: randomUUID(), deviceId: randomUUID(), kind: 'publish' }, async (tx: any) => { await tx.checkpoint(); })).rejects.toThrow('Pending query');
    expect(() => p.pendingTransactions()).toThrow();
    expect(released).toHaveLength(0);
});
const quotaRoots: string[] = [];
afterEach(() => { for (const root of quotaRoots.splice(0))
    rmSync(root, { recursive: true, force: true }); });
function realQuota() { const root = realpathSync(mkdtempSync(join(tmpdir(), 'heed-direct-quota-'))); quotaRoots.push(root); const catalog = join(root, 'library/catalog'); mkdirSync(catalog, { recursive: true }); const quota = new ManagedQuota({ ledgerPath: join(root, 'quota.json'), roots: { text: [catalog] }, getLimit: () => 32000000, setLimit() { }, protectedPaths: () => [] }); return { root, catalog, quota }; }
test.each(['credentials', 'reaped-open'] as const)('real quota releases proved no-job %s failure and admits a fresh operation', async (failure) => {
    const q = realQuota(), f = fixture();
    let credentialCalls = 0, openCalls = 0;
    const session = { command: async () => null, close: async () => { } };
    const native = { pending: async () => [], open: async () => { openCalls++; if (failure === 'reaped-open' && openCalls === 1)
            throw Object.assign(Error('Access denied'), { guardianStopped: true }); return session; } } as any;
    const p = new Provider(f.b, native, async () => { credentialCalls++; if (failure === 'credentials' && credentialCalls === 1)
        throw Error('Credential unavailable'); return { username: 'qa', password: 'secret', domain: '' }; }, q.root, q.quota);
    await p.initialize();
    await expect(p.withTransaction({ operationId: randomUUID(), deviceId: randomUUID(), kind: 'read' }, async () => { })).rejects.toThrow();
    expect(q.quota.snapshot().reservedBytes).toBe(0);
    await p.withTransaction({ operationId: randomUUID(), deviceId: randomUUID(), kind: 'read' }, async (tx: any) => tx.checkpoint());
    expect(q.quota.snapshot().reservedBytes).toBe(0);
    expect(credentialCalls).toBe(2);
});
test('real quota separates unresolved jobs and reuses the exact original recovery reservation', async () => {
    const q = realQuota(), f = fixture(), original = { operationId: randomUUID(), deviceId: randomUUID(), kind: 'delete' as const };
    let pending: any[] = [], openCalls = 0;
    const job = { ...original, recoverable: true, admissions: [] };
    const native = { pending: async () => pending, open: async () => { openCalls++; if (openCalls === 1) {
            pending = [job];
            throw Object.assign(Error('Claim retained'), { guardianStopped: true });
        } return { command: async () => null, close: async () => { if (openCalls === 3)
                pending = []; } }; } } as any;
    const p = new Provider(f.b, native, async () => ({ username: 'qa', password: 'secret', domain: '' }), q.root, q.quota);
    await p.initialize();
    await expect(p.withTransaction(original, async () => { })).rejects.toThrow('Claim');
    expect(q.quota.snapshot().reservedBytes).toBe(8000000);
    await p.withTransaction({ ...original, operationId: randomUUID(), kind: 'read' }, async (tx: any) => tx.checkpoint());
    expect(q.quota.snapshot().reservedBytes).toBe(8000000);
    await p.withTransaction(original, async (tx: any) => tx.checkpoint());
    expect(q.quota.snapshot().reservedBytes).toBe(0);
});
test('real quota owns journal replacement siblings without double-counting their staged bytes', async () => {
    const q = realQuota(), f = fixture(), context = { operationId: randomUUID(), deviceId: randomUUID(), kind: 'read' as const };
    let accounted = 0;
    const native = { pending: async () => [], open: async () => { const folder = join(q.catalog, 'direct-smb', f.b.id); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, context.operationId + '.json'), 'journal'); writeFileSync(join(folder, context.operationId + '.json.' + randomUUID() + '.tmp'), 'copy'); writeFileSync(join(folder, context.operationId + '.guard'), ''); const snapshot = q.quota.snapshot(); accounted = snapshot.usedBytes + snapshot.reservedBytes; return { command: async () => null, close: async () => { } }; } } as any;
    const p = new Provider(f.b, native, async () => ({ username: 'qa', password: 'secret', domain: '' }), q.root, q.quota);
    await p.initialize();
    await p.withTransaction(context, async (tx: any) => tx.checkpoint());
    expect(accounted).toBe(8000000);
});
