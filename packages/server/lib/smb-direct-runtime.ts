import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
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

/** Private witness: only a prelaunch refusal or fulfilled owned exit proves stop. */
function runtimeFailure(stopped: boolean) {
    const failure = directSmbError('runtime-unavailable');
    if (stopped) {
        Object.defineProperty(failure, 'guardianStopped', { value: true, enumerable: false });
    }
    return failure;
}

/** Verify local release bytes before any credential-bearing helper is launched. */
export async function verifyDirectSmbRuntime(helper: string): Promise<string> {
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
    let launchAttempted = false;
    let exitProven = false;
    let owned: {
        pid?: number;
        kill: (signal?: number | NodeJS.Signals) => void;
        exited: Promise<number>;
    } | undefined;
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
        const target = join(root, 'runtime/smb');
        const names = ['python', 'python3', 'python3.12', 'activate', 'activate.csh', 'activate.fish',
            'Activate.ps1', 'cffi-gen-src', 'pyspnego-parse'];
        if (!receipt.bootstrap || Object.keys(receipt.bootstrap).length !== names.length + 1 ||
            JSON.stringify(readdirSync(join(target, 'bin')).sort()) !== JSON.stringify(names.sort()) ||
            JSON.stringify(readdirSync(join(target, 'lib/python3.12'))) !== JSON.stringify(['site-packages']))
            throw directSmbError('runtime-unavailable');
        for (const name of ['pyvenv.cfg', ...names.map(name => 'bin/' + name)])
            if (hash(regular(join(target, name))) !== receipt.bootstrap[name]) throw directSmbError('runtime-unavailable');
        const config = regular(join(target, 'pyvenv.cfg'), 4096).toString('utf8');
        const home = /^home = (.+)$/m.exec(config)?.[1];
        if (!home || realpathSync(join(home, 'python3.12')) !== receipt.basePython ||
            !config.includes('include-system-site-packages = false\n')) throw directSmbError('runtime-unavailable');
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
        launchAttempted = true;
        child = Bun.spawn([executable, '-I', '-S', '-B', join(folder, 'runtime.py'), 'verify', root],
            { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true });
        // Track fulfilled exit evidence, not a rejected exit promise. Unknown lifetime
        // stays supervised; only eventual verified exit may retire this owner.
        const exit = child.exited.then(
            code => { exitProven = true; return code; },
            () => new Promise<number>(() => {}),
        );
        owned = track({
            pid: child.pid,
            kill: signal => child!.kill(signal as number),
            exited: exit,
        });
        const exited = await Promise.race([exit, new Promise<never>((_, reject) => {
            timeout = setTimeout(() => { killTree(owned!, 'SIGKILL'); reject(directSmbError('runtime-unavailable')); }, 30000);
        })]);
        if (exited !== 0) throw directSmbError('runtime-unavailable');
        untrack(owned);
        return executable;
    } catch {
        clearTimeout(timeout);
        if (owned && !exitProven) {
            killTree(owned, 'SIGKILL');
            await Promise.race([owned.exited, new Promise<void>(resolve => {
                cleanupTimeout = setTimeout(resolve, 1500);
            })]);
        }
        throw runtimeFailure(!launchAttempted || exitProven);
    } finally {
        clearTimeout(timeout);
        clearTimeout(cleanupTimeout);
    }
}

export async function spawnDirectSmbGuardian(helper: string): Promise<ReturnType<typeof Bun.spawn>> {
    const python = await verifyDirectSmbRuntime(helper);
    const folder = dirname(resolve(helper)), root = resolve(folder, '../../../..');
    return Bun.spawn([python, '-I', '-S', '-B', join(folder, 'runtime.py'), 'guardian', root], {
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true,
    });
}
