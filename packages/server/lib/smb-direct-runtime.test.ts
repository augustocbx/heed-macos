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

test('verification never runs an unexpected startup hook', async () => {
    const { existsSync } = await import('node:fs');
    const hook = join(root, 'runtime/smb/lib/python3.12/site-packages/unreviewed.pth');
    const marker = join(root, 'unexpected-startup.txt');
    // Public fixture marker only; no provider input or credentials.
    writeFileSync(hook, `import sys; open(${JSON.stringify(marker)}, 'w').write('unexpected') if 'verify' in sys.argv else None\n`);
    try {
        await expect(verifyDirectSmbRuntime(helper)).rejects.toMatchObject({ code: 'runtime-unavailable' });
        expect(existsSync(marker)).toBe(false);
    } finally { rmSync(hook); rmSync(marker, { force: true }); }
});
test('a package directory cannot replace the verified guardian module', async () => {
    const { mkdirSync } = await import('node:fs');
    const injected = join(root, 'packages/server/native/smb-direct/guardian');
    mkdirSync(injected);
    writeFileSync(join(injected, '__init__.py'), 'def main():\n    return None\n');
    try {
        let rejected = false;
        try { const child = await spawnDirectSmbGuardian(helper); (child.stdin as Bun.FileSink).end(); await child.exited; }
        catch (error) { rejected = (error as {code?:string}).code === 'runtime-unavailable'; }
        expect(rejected).toBe(true);
    } finally { rmSync(injected, { recursive: true }); }
});

test('bootstrap configuration and import-path overrides are refused before startup', async () => {
    const config = join(root, 'runtime/smb/pyvenv.cfg'), original = readFileSync(config);
    try {
        writeFileSync(config, original.toString('utf8').replace(/^home = .+$/m, 'home = /unexpected-public-fixture'));
        await expect(verifyDirectSmbRuntime(helper)).rejects.toMatchObject({ code: 'runtime-unavailable' });
    } finally { writeFileSync(config, original); }
    const extra = join(root, 'runtime/smb/bin/python._pth');
    writeFileSync(extra, 'unreviewed import path\n');
    try { await expect(verifyDirectSmbRuntime(helper)).rejects.toMatchObject({ code: 'runtime-unavailable' }); }
    finally { rmSync(extra); }
});

/** Module mocks live only in a disposable fixture process; the production default runner stays intact. */
async function preflightFixture(
  mode:
    | 'unresolved'
    | 'rejected'
    | 'prelaunch'
    | 'failed'
    | 'success'
    | 'spawn-failure',
) {
  const child = Bun.spawn([process.execPath, 'run', '-'], {
    cwd: join(import.meta.dir, '../../..'),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HEED_LOG_LEVEL: 'error' },
  });
  const script = String.raw`
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const originalFs = { ...fs },
  root = process.cwd(),
  folder = join(root, 'packages/server/native/smb-direct'),
  target = join(root, 'runtime/smb'),
  mode = ${JSON.stringify(mode)};
const files = new Map(),
  hash = (data) => createHash('sha256').update(data).digest('hex'),
  executable = Buffer.from('synthetic executable'),
  base = '/synthetic/python3.12';
const names = [
    'python',
    'python3',
    'python3.12',
    'activate',
    'activate.csh',
    'activate.fish',
    'Activate.ps1',
    'cffi-gen-src',
    'pyspnego-parse',
  ],
  sources = [
    'runtime.py',
    'guardian.py',
    'transport.py',
    'identity.py',
    'protocol.py',
  ];
files.set(base, executable);
for (const name of names) files.set(join(target, 'bin', name), executable);
files.set(
  join(target, 'pyvenv.cfg'),
  Buffer.from('home = /synthetic\ninclude-system-site-packages = false\n'),
);
for (const name of sources) files.set(join(folder, name), Buffer.from(name));
const receipt = {
  schemaVersion: mode === 'prelaunch' ? 999 : 1,
  python: '3.12',
  architecture: 'arm64',
  minimumMacOS: '14.0',
  basePython: base,
  executableSha256: hash(executable),
  baseSha256: hash(executable),
  bootstrap: Object.fromEntries(
    ['pyvenv.cfg', ...names.map((n) => 'bin/' + n)].map((n) => [
      n,
      hash(files.get(join(target, n))),
    ]),
  ),
  sources: Object.fromEntries(
    sources.map((n) => [n, hash(files.get(join(folder, n)))]),
  ),
};
files.set(join(target, 'receipt.json'), Buffer.from(JSON.stringify(receipt)));
mock.module('node:fs', () => ({
  ...originalFs,
  lstatSync: (path) =>
    files.has(path)
      ? { isFile: () => true, size: files.get(path).length }
      : originalFs.lstatSync(path),
  readFileSync: (path, ...args) =>
    files.has(path) ? files.get(path) : originalFs.readFileSync(path, ...args),
  realpathSync: (path) =>
    files.has(path) ? path : originalFs.realpathSync(path),
  readdirSync: (path, ...args) =>
    path === join(target, 'bin')
      ? [...names]
      : path === join(target, 'lib/python3.12')
        ? ['site-packages']
        : originalFs.readdirSync(path, ...args),
}));
const { PythonDirectSmbNative } = await import(
    './packages/server/lib/smb-direct-native.ts'
  ),
  { DirectSmbConnections } = await import(
    './packages/server/lib/smb-direct-connections.ts'
  ),
  { ProviderRegistry } = await import(
    './packages/server/lib/provider-registry.ts'
  ),
  { reapAll } = await import('./packages/server/lib/process.ts');
const originalSpawn = Bun.spawn,
  originalTimeout = globalThis.setTimeout;
let launches = 0,
  guardians = 0,
  kills = 0,
  resolveExit,
  nativeFailure;
const exited =
  mode === 'failed'
    ? Promise.resolve(7)
    : mode === 'success' || mode === 'spawn-failure'
      ? Promise.resolve(0)
      : mode === 'rejected'
        ? Promise.reject(Error('Unproved exit rejection'))
        : new Promise((r) => (resolveExit = r));
const verifier = {
  exited,
  exitCode:
    mode === 'failed'
      ? 7
      : mode === 'success' || mode === 'spawn-failure'
        ? 0
        : null,
  kill: () => kills++,
};
const identity = {
    serverGuid: '1'.repeat(32),
    volumeSerial: '12345678',
    volumeCreated: '1234567890abcdef',
    rootId: '1234567890abcdef',
    rootCreated: '1234567890abcdee',
  },
  probe = {
    identity,
    dialect: '3.1.1',
    authentication: 'authenticated',
    security: 'encrypted',
    encrypted: true,
    namespaceSafe: true,
    readOnly: false,
    destinationId: null,
    destinationVersion: null,
    empty: true,
  };
Bun.spawn = (args) => {
  if (args[5] === 'verify') {
    launches++;
    return verifier;
  }
  if (args[5] !== 'guardian') throw Error('Unexpected spawn');
  guardians++;
  if (mode === 'spawn-failure')
    throw Object.assign(Error('Synthetic spawn failure diagnostic'), {
      code: 'runtime-unavailable',
    });
  return {
    exited: Promise.resolve(0),
    exitCode: 0,
    kill: () => kills++,
    stdin: { write: () => {}, flush: async () => {}, end: () => {} },
    stdout: new ReadableStream({
      start(c) {
        c.enqueue(
          Buffer.from(JSON.stringify({ ok: true, value: probe }) + '\n'),
        );
        c.close();
      },
    }),
  };
};
globalThis.setTimeout = (fn, ms, ...args) =>
  originalTimeout(fn, [30000, 1500].includes(ms) ? 1 : ms, ...args);
const app = originalFs.mkdtempSync(
    join(tmpdir(), 'heed-preflight-controller-'),
  ),
  registry = new ProviderRegistry({
    path: join(app, 'provider.json'),
    getLibrary: () => {
      throw Error('Unexpected library access');
    },
  }),
  native = new PythonDirectSmbNative(),
  originalProbe = native.probe.bind(native);
native.probe = async (...args) => {
  try {
    return await originalProbe(...args);
  } catch (error) {
    nativeFailure = error;
    throw error;
  }
};
const controls = new DirectSmbConnections({
    path: join(app, 'direct.json'),
    appDir: app,
    registry,
    library: () => ({ preempt: async () => {} }),
    native,
    busy: () => false,
    quota: { reserve() {}, release() {} },
    sessions: () => [],
  }),
  endpoint = {
    server: 'nas.test',
    port: 445,
    share: 'Meetings',
    folder: 'Library',
    requireEncryption: true,
  },
  credentials = { username: 'synthetic', password: 'synthetic', domain: '' };
let failure,
  drainFailure,
  retryFailure,
  result,
  tracked = false,
  retired = false;
try {
  try {
    result = await controls.test(endpoint, credentials);
  } catch (error) {
    failure = error;
  }
  try {
    await controls.preempt();
  } catch (error) {
    drainFailure = error;
  }
  if (mode === 'unresolved' || mode === 'rejected') {
    try {
      await controls.test(endpoint, credentials);
    } catch (error) {
      retryFailure = error;
    }
    const before = kills;
    const reaping = reapAll(1);
    await new Promise((r) => originalTimeout(r, 5));
    tracked = kills > before;
    if (resolveExit) {
      verifier.exitCode = 0;
      resolveExit(0);
      await reaping;
      const beforeRetirement = kills;
      await reapAll(1);
      retired = kills === beforeRetirement;
    } else {
      void reaping.catch(() => {});
    }
  }
  console.log(
    JSON.stringify({
      mode,
      launches,
      guardians,
      kills,
      tracked,
      retired,
      code: failure?.code,
      proof: nativeFailure?.guardianStopped ?? false,
      enumerable: Object.keys(nativeFailure ?? {}).includes('guardianStopped'),
      recovery: controls.snapshot().recoveryRequired,
      drain: drainFailure?.code ?? null,
      retry: retryFailure?.code ?? null,
      receipt: !!result?.receipt,
    }),
  );
} finally {
  Bun.spawn = originalSpawn;
  globalThis.setTimeout = originalTimeout;
  await controls.close().catch(() => {});
  originalFs.rmSync(app, { recursive: true, force: true });
}

`;
  (child.stdin as Bun.FileSink).write(script);
  (child.stdin as Bun.FileSink).end();
  const output = await new Response(
      child.stdout as ReadableStream<Uint8Array>,
    ).text(),
    errors = await new Response(
      child.stderr as ReadableStream<Uint8Array>,
    ).text();
  if (errors) throw Error(errors);
  expect(await child.exited).toBe(0);
  return JSON.parse(output.trim().split('\n').at(-1)!);
}
test('N1 production default preflight unproved exits provide no stop authority and poison controller admission', async () => {
  for (const mode of ['unresolved', 'rejected'] as const) {
    const result = await preflightFixture(mode);
    expect(result.launches).toBe(1);
    expect(result.guardians).toBe(0);
    expect(result.proof).toBe(false);
    expect(result.recovery).toBe(true);
    expect(result.code).toBe('recovery-required');
    expect(result.drain).toBe('recovery-required');
    expect(result.retry).toBe('recovery-required');
    expect(result.tracked).toBe(true);
    expect(result.retired).toBe(mode === 'unresolved');
    expect(result.enumerable).toBe(false);
  }
});
test('N1 production default preflight issues stopped evidence only for zero-launch refusal or verified child exit', async () => {
  for (const mode of ['prelaunch', 'failed', 'success'] as const) {
    const result = await preflightFixture(mode);
    expect(result.recovery).toBe(false);
    expect(result.drain).toBeNull();
    expect(result.launches).toBe(mode === 'prelaunch' ? 0 : 1);
    expect(result.guardians).toBe(mode === 'success' ? 1 : 0);
    expect(result.proof).toBe(mode !== 'success');
    expect(result.receipt).toBe(mode === 'success');
    expect(result.enumerable).toBe(false);
  }
});

test('N1 guardian spawn rejection cannot inherit a completed preflight stop receipt', async () => {
  const result = await preflightFixture('spawn-failure');
  expect(result.launches).toBe(1);
  expect(result.guardians).toBe(1);
  expect(result.proof).toBe(false);
  expect(result.recovery).toBe(true);
  expect(result.code).toBe('recovery-required');
  expect(result.drain).toBe('recovery-required');
  expect(result.receipt).toBe(false);
});
