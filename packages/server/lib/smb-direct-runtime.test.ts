import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDirectSmbRuntime, spawnDirectSmbGuardian } from './smb-direct-runtime';

let root: string, helper: string;
const source = fileURLToPath(new URL('../native/smb-direct', import.meta.url));
beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'heed-direct-runtime-')));
    const folder = join(root, 'packages/server/native/smb-direct');
    cpSync(source, folder, { recursive: true, filter: (p) => !p.includes('__pycache__') });
    helper = join(folder, 'guardian.py');
    const base = process.env.HEED_SMB_PYTHON ?? '/opt/homebrew/bin/python3.12';
    const result = Bun.spawn([base, '-I', '-B', join(folder, 'runtime.py'), 'install', root, '--python', base],
        { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    expect(await result.exited).toBe(0);
}, 30000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('validates the exact detached offline runtime before returning its executable', async () => {
    expect(await verifyDirectSmbRuntime(helper)).toBe(join(root, 'runtime/smb/bin/python'));
});
test('refuses changed executable, helper or receipt with a sanitized public code', async () => {
    for (const path of [join(root, 'runtime/smb/bin/python'), helper, join(root, 'runtime/smb/receipt.json')]) {
        const original = readFileSync(path);
        try {
            writeFileSync(path, Buffer.concat([original, Buffer.from('altered')]));
            await expect(verifyDirectSmbRuntime(helper)).rejects.toMatchObject({ code: 'runtime-unavailable' });
        } finally { writeFileSync(path, original); }
    }
});
test('refuses an executable symlink or injected executable package content', async () => {
    const path = join(root, 'runtime/smb/bin/python'), original = readFileSync(path);
    rmSync(path);
    symlinkSync('/usr/bin/python3', path);
    try { await expect(verifyDirectSmbRuntime(helper)).rejects.toMatchObject({ code: 'runtime-unavailable' }); }
    finally { rmSync(path); writeFileSync(path, original, { mode: 0o755 }); }
    const injected = join(root, 'runtime/smb/lib/python3.12/site-packages/unreviewed.pth');
    writeFileSync(injected, 'import os\n');
    try { await expect(verifyDirectSmbRuntime(helper)).rejects.toMatchObject({ code: 'runtime-unavailable' }); }
    finally { rmSync(injected); }
});

test('launches the detached guardian with isolated imports and sanitized errors', async () => {
    const child = await spawnDirectSmbGuardian(helper);
    const sink = child.stdin as Bun.FileSink;
    sink.write(JSON.stringify({ protocol: 999, password: 'public-do-not-log-sentinel' }) + '\n');
    sink.end();
    const output = await new Response(child.stdout as ReadableStream<Uint8Array>).text();
    expect(await new Response(child.stderr as ReadableStream<Uint8Array>).text()).toBe('');
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toEqual({ ok: false, error: 'invalid-protocol' });
    expect(output).not.toContain('public-do-not-log-sentinel');
});
