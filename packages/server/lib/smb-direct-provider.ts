import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import type { DeletionCapabilities, PortableCommit, RemoteInventory } from '@heed/shared';
import type { LibraryProvider, PendingRemoteTransaction, QuotaBudget, RemoteTransaction, TransactionContext } from './portable-provider';
import { providerPath } from './portable-provider';
import type { DirectSmbBinding, DirectSmbCredentials, DirectSmbNative, DirectSmbSession } from './smb-direct-types';
import { directSmbError, validateDirectBinding, validateDirectContext } from './smb-direct-types';
import { validateDirectPending } from './smb-direct-native';
import { encode, sha256, validateCommit } from './portable-schema';
import { validateArtifactIdentity, validateDeletionRecord, validatePublicationIntent, validateRevisionFence } from './portable-deletion-schema';
interface Scope {
    session: DirectSmbSession;
    transaction: RemoteTransaction;
    context: TransactionContext;
    closed: boolean;
    checkpointed: boolean;
}
const MAX_BYTES = 8000000000000;
function count(n: number) {
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_BYTES)
        throw directSmbError('invalid-input');
}
/** One native guardian owns all remote I/O;
credentials are resolved per operation. */
export class DirectSmbProvider implements LibraryProvider, RemoteTransaction {
    readonly id: string;
    readonly name: string;
    readonly readOnly: boolean;
    readonly transport = 'authenticated-network' as const;
    readonly deletionCapabilities: DeletionCapabilities;
    readonly capabilities: {
        read: boolean;
        write: boolean;
        transportSecurity: 'signed' | 'encrypted';
        remoteDeletion: boolean;
        durability: 'share-readback';
    };
    private binding: DirectSmbBinding;
    private scope = new AsyncLocalStorage<Scope>();
    private busy = false;
    private pending?: PendingRemoteTransaction[];
    constructor(binding: DirectSmbBinding, private native: DirectSmbNative, private getCredentials: () => Promise<DirectSmbCredentials>, private appDir: string, private quota?: QuotaBudget) {
        this.binding = structuredClone(validateDirectBinding(binding));
        validateDirectContext({ operationId: binding.id, deviceId: binding.id, kind: 'read', appDir });
        this.id = binding.id;
        this.name = binding.name;
        this.readOnly = binding.readOnly;
        this.deletionCapabilities = { revisionMetadata: !binding.readOnly, sharedAudioGC: false, exclusion: 'exclusive-create', confirmation: 'pending-verification', destinationVersion: 3, destinationId: binding.destinationId, connectionGeneration: sha256(encode(this.binding)), blockedReason: binding.readOnly ? 'Direct SMB v3 requires writable coordination access.' : 'Real server enforcement and deletion acceptance remain pending.' };
        this.capabilities = { read: !binding.readOnly, write: !binding.readOnly, transportSecurity: binding.security, remoteDeletion: !binding.readOnly, durability: 'share-readback' };
    }
    /** Await this pure local query before activating the provider in a registry. */
    async initialize(signal?: AbortSignal): Promise<this> {
        if (this.busy)
            throw directSmbError('destination-busy');
        this.pending = undefined;
        this.pending = validateDirectPending(await this.native.pending(this.binding, this.appDir, signal));
        return this;
    }
    pendingTransactions(): PendingRemoteTransaction[] {
        if (!this.pending || this.busy)
            throw directSmbError('recovery-required');
        return structuredClone(this.pending);
    }
    private active() {
        const box = this.scope.getStore();
        if (!box || box.closed)
            throw directSmbError('transaction-unavailable');
        return box;
    }
    async withTransaction<T>(context: TransactionContext, run: (transaction: RemoteTransaction) => Promise<T>, signal?: AbortSignal): Promise<T> {
        signal?.throwIfAborted();
        validateDirectContext({ ...context, appDir: this.appDir });
        if (this.readOnly)
            throw directSmbError('read-only');
        const borrowed = this.scope.getStore();
        if (borrowed) {
            if (borrowed.closed || borrowed.context.deviceId !== context.deviceId || borrowed.context.operationId !== context.operationId && context.kind !== 'read' || borrowed.context.kind === 'read' && context.kind !== 'read')
                throw directSmbError('unsupported-coordination');
            return run(borrowed.transaction);
        }
        if (this.busy)
            throw directSmbError('destination-busy');
        if (!this.pending)
            throw directSmbError('recovery-required');
        this.busy = true;
        this.pending = undefined;
        let session: DirectSmbSession | undefined, box: Scope | undefined, reserved = false, closed = false, openAttempted = false, failedOpenStopped = false;
        const quotaId = 'direct-smb-' + context.operationId;
        try {
            if (this.quota) {
                this.quota.reserve(quotaId, 8000000, ['json', 'guard'].map(extension => join(this.appDir, 'library/catalog/direct-smb', this.id, context.operationId + '.' + extension)));
                reserved = true;
            }
            const credentials = await this.getCredentials();
            openAttempted = true;
            session = await this.native.open(this.binding, credentials, { ...context, appDir: this.appDir }, signal);
            const command = async (action: string, value?: Record<string, unknown>, s?: AbortSignal) => {
                this.active();
                if (action !== 'checkpoint' && ['write-deletion', 'write-fence', 'write-pending', 'retire-pending', 'remove-exact'].includes(action))
                    this.active().checkpointed = false;
                return session!.command(action, value, s);
            };
            const transaction: RemoteTransaction = { observationDigest: async () => {
                    const result = await command('observation-digest');
                    if (typeof result !== 'string' || !/^[a-f0-9]{64}$/.test(result))
                        throw directSmbError('invalid-protocol');
                    return result;
                }, checkpoint: async () => {
                    await command('checkpoint');
                    this.active().checkpointed = true;
                }, inventory: async (s) => {
                    const raw = await command('inventory', undefined, s) as RemoteInventory;
                    if (!raw || Object.keys(raw).sort().join(',') !== 'commits,complete,deletions,pending' || raw.complete !== true || [raw.commits, raw.deletions, raw.pending].some(a => !Array.isArray(a) || a.length > 10000))
                        throw directSmbError('invalid-protocol');
                    raw.commits.forEach(validateCommit);
                    raw.deletions.forEach(validateDeletionRecord);
                    raw.pending.forEach(validatePublicationIntent);
                    if (raw.deletions.some(r => r.destinationId !== this.binding.destinationId))
                        throw directSmbError('identity-changed');
                    return raw;
                }, writeDeletion: async (r, s) => {
                    validateDeletionRecord(r);
                    await command('write-deletion', { value: r }, s);
                }, writeFence: async (r, s) => {
                    validateRevisionFence(r);
                    await command('write-fence', { value: r }, s);
                }, writePending: async (r, s) => {
                    validatePublicationIntent(r);
                    await command('write-pending', { value: r }, s);
                }, retirePending: async (r, s) => {
                    validatePublicationIntent(r);
                    await command('retire-pending', { value: r }, s);
                }, removeExact: async (jobId, artifact, s) => {
                    validateArtifactIdentity(artifact);
                    const result = await command('remove-exact', { jobId, artifact }, s);
                    if (result !== 'removed' && result !== 'already-removed')
                        throw directSmbError('invalid-protocol');
                    return result;
                } };
            box = { session, transaction, context: structuredClone(context), closed: false, checkpointed: false };
            return await this.scope.run(box, () => run(transaction));
        }
        catch (error) {
            failedOpenStopped = !session && (!openAttempted || (error as {
                guardianStopped?: unknown;
            })?.guardianStopped === true);
            throw error;
        }
        finally {
            if (box)
                box.closed = true;
            try {
                if (session) {
                    await session.close();
                    closed = true;
                }
            }
            finally {
                this.busy = false;
                await this.initialize();
                if (reserved && (failedOpenStopped || closed && box?.checkpointed) && !this.pendingTransactions().some(job => job.operationId === context.operationId))
                    this.quota!.release(quotaId);
            }
        }
    }
    observationDigest() {
        return this.active().transaction.observationDigest!();
    }
    checkpoint() {
        return this.active().transaction.checkpoint();
    }
    inventory(signal?: AbortSignal) {
        return this.active().transaction.inventory(signal);
    }
    writeDeletion(...args: Parameters<RemoteTransaction['writeDeletion']>) {
        return this.active().transaction.writeDeletion(...args);
    }
    writeFence(...args: Parameters<RemoteTransaction['writeFence']>) {
        return this.active().transaction.writeFence(...args);
    }
    writePending(...args: Parameters<RemoteTransaction['writePending']>) {
        return this.active().transaction.writePending(...args);
    }
    retirePending(...args: Parameters<RemoteTransaction['retirePending']>) {
        return this.active().transaction.retirePending(...args);
    }
    removeExact(...args: Parameters<RemoteTransaction['removeExact']>) {
        return this.active().transaction.removeExact(...args);
    }
    async list(cursor: string | null, limit: number, signal?: AbortSignal) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            throw directSmbError('invalid-input');
        const inventory = await this.active().transaction.inventory(signal), commits = inventory.commits.slice().sort((a, b) => `${a.deviceId}/${a.revisionId}`.localeCompare(`${b.deviceId}/${b.revisionId}`)), hash = sha256(encode(commits));
        let offset = 0;
        if (cursor !== null) {
            if (!new RegExp(`^${hash}:[0-9]{1,5}$`).test(cursor))
                throw directSmbError('identity-changed');
            offset = Number(cursor.split(':')[1]);
            if (offset >= commits.length)
                throw directSmbError('invalid-input');
        }
        return { commits: commits.slice(offset, offset + limit), next: offset + limit < commits.length ? `${hash}:${offset + limit}` : null, complete: true };
    }
    async read(path: string, maxBytes: number, signal?: AbortSignal) {
        providerPath(path);
        count(maxBytes);
        const bytes = await this.active().session.read(path, maxBytes, signal);
        if (bytes.length > maxBytes)
            throw directSmbError('bounds-exceeded');
        return bytes;
    }
    async *stream(path: string, maxBytes: number, signal?: AbortSignal) {
        providerPath(path);
        count(maxBytes);
        let received = 0;
        for await (const c of this.active().session.stream(path, maxBytes, signal)) {
            received += c.length;
            if (received > maxBytes)
                throw directSmbError('bounds-exceeded');
            yield c;
        }
    }
    async writeImmutable(path: string, bytes: Uint8Array, signal?: AbortSignal) {
        providerPath(path);
        const box = this.active();
        if (box.context.kind !== 'publish')
            throw directSmbError('unsupported-coordination');
        box.checkpointed = false;
        await box.session.write(path, bytes.length, sha256(bytes), (async function* () {
            yield bytes;
        })(), signal);
    }
    async writeObjectImmutable(path: string, bytes: number, hash: string, source: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
        count(bytes);
        if (!/^[a-f0-9]{64}$/.test(hash) || path !== `objects/${hash}`)
            throw directSmbError('invalid-input');
        const box = this.active();
        if (box.context.kind !== 'publish')
            throw directSmbError('unsupported-coordination');
        box.checkpointed = false;
        await box.session.write(path, bytes, hash, source, signal);
    }
    async confirm(commit: PortableCommit, signal?: AbortSignal): Promise<'remote-confirmed'> {
        validateCommit(commit);
        const result = await this.active().session.command('confirm', { commit }, signal);
        if (result !== 'remote-confirmed')
            throw directSmbError('invalid-protocol');
        return result;
    }
}
