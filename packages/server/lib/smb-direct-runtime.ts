import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { directSmbError } from './smb-direct-types';
import { killTree, track, untrack } from './process';

function regular(path: string, maximum = 16000000): Buffer {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > maximum || realpathSync(path) !== path)
        throw directSmbError('runtime-unavailable');
    return readFileSync(path);
}
function hash(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }

/** Verify local release bytes before any credential-bearing helper is launched. */
export async function verifyDirectSmbRuntime(helper: string): Promise<string> {
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        helper = resolve(helper);
        const folder = dirname(helper), root = resolve(folder, '../../../..');
        if (helper !== join(root, 'packages/server/native/smb-direct/guardian.py'))
            throw directSmbError('runtime-unavailable');
        const executable = join(root, 'runtime/smb/bin/python');
        const receipt = JSON.parse(regular(join(root, 'runtime/smb/receipt.json'), 65536).toString('utf8'));
        if (receipt.schemaVersion !== 1 || receipt.python !== '3.12' || receipt.architecture !== 'arm64' ||
            receipt.minimumMacOS !== '14.0' || typeof receipt.basePython !== 'string' ||
            resolve(receipt.basePython) !== receipt.basePython || !receipt.sources ||
            hash(regular(executable)) !== receipt.executableSha256 ||
            receipt.executableSha256 !== receipt.baseSha256 ||
            hash(regular(receipt.basePython)) !== receipt.baseSha256)
            throw directSmbError('runtime-unavailable');
        for (const [name, expected] of Object.entries(receipt.sources)) {
            if (!/^[a-z][a-z0-9_]*\.py$/.test(name) || typeof expected !== 'string' ||
                !/^[a-f0-9]{64}$/.test(expected) || hash(regular(join(folder, name))) !== expected)
                throw directSmbError('runtime-unavailable');
        }
        if (!['runtime.py', 'guardian.py', 'transport.py', 'identity.py', 'protocol.py'].every(name =>
            Object.hasOwn(receipt.sources, name))) throw directSmbError('runtime-unavailable');
        // This protected preflight receives no provider credential or RPC input.
        // Python checks installed bytes against each pinned public wheel, rejects
        // extra modules/startup hooks and verifies this release's receipt.
        child = track(Bun.spawn([executable, '-I', '-B', join(folder, 'runtime.py'), 'verify', root],
            { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true }));
        const exited = await Promise.race([child.exited, new Promise<never>((_, reject) => {
            timeout = setTimeout(() => { killTree(child!, 'SIGKILL'); reject(directSmbError('runtime-unavailable')); }, 30000);
        })]);
        if (exited !== 0) throw directSmbError('runtime-unavailable');
        untrack(child);
        return executable;
    } catch {
        throw directSmbError('runtime-unavailable');
    } finally {
        clearTimeout(timeout);
        if (child && child.exitCode === null) {
            killTree(child, 'SIGKILL');
            await Promise.race([child.exited.then(() => untrack(child!)), new Promise<void>(resolve => setTimeout(resolve, 1500))]);
        }
    }
}

export async function spawnDirectSmbGuardian(helper: string): Promise<ReturnType<typeof Bun.spawn>> {
    const python = await verifyDirectSmbRuntime(helper);
    const folder = dirname(resolve(helper)), root = resolve(folder, '../../../..');
    return Bun.spawn([python, '-I', '-B', join(folder, 'runtime.py'), 'guardian', root], {
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true,
    });
}
