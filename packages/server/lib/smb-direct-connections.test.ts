import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DirectSmbConnections } from "./smb-direct-connections";
import { ProviderRegistry } from "./provider-registry";
import { PortableLibrary } from "./portable-library";
import { SessionTags } from "./session-tags";
import { atomicWriteJson } from "./atomic-json";
import type {
  DirectSmbNative,
  DirectSmbBinding,
  DirectSmbProbe,
  DirectSmbCredentials,
} from "./smb-direct-types";
import type { PendingRemoteTransaction } from "./portable-provider";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const endpoint = {
  server: "nas.test",
  port: 445,
  share: "Meetings",
  folder: "Library",
  requireEncryption: true,
};
const credentials = {
  username: "private-account",
  password: "private-password",
  domain: "PRIVATE",
};
const identity = {
  serverGuid: "1".repeat(32),
  volumeSerial: "12345678",
  volumeCreated: "1234567890abcdef",
  rootId: "1234567890abcdef",
  rootCreated: "1234567890abcdee",
};
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "heed-direct-controls-"));
  roots.push(root);
  const sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir);
  const sessions = new SessionTags(sessionsDir),
    quota = { reserve() {}, release() {} };
  const library = new PortableLibrary({
      root: join(root, "library"),
      sessions,
      sessionsDir,
      quota,
    }),
    registry = new ProviderRegistry({
      path: join(root, "preference.json"),
      getLibrary: () => library,
      write: (path, value) => {
        if (failPreference) throw Error("private-password preference failed");
        atomicWriteJson(path, value);
      },
    });
  const secrets = new Map<string, unknown>(),
    events: string[] = [],
    contexts: string[] = [];
  let clock = 1000,
    busy = false,
    failPut = false,
    failGet = false,
    failRemove = false,
    failWrite = false,
    failPreference = false,
    pending: PendingRemoteTransaction[] = [],
    pendingWait: Promise<void> | undefined,
    probeWait: Promise<void> | undefined,
    openWait: Promise<void> | undefined;
  let destination: string | null = randomUUID(),
    binding: DirectSmbBinding | undefined;
  const probe = (): DirectSmbProbe => ({
    identity,
    dialect: "3.1.1",
    authentication: "authenticated",
    security: "encrypted",
    encrypted: true,
    namespaceSafe: true,
    readOnly: false,
    destinationId: destination,
    destinationVersion: destination ? 3 : null,
    empty: !destination,
  });
  const native: DirectSmbNative = {
    async probe() {
      events.push("probe");
      await probeWait;
      return probe();
    },
    async initialize(_e, _c, _i, id) {
      events.push("initialize");
      destination = id;
      return probe();
    },
    async pending(b) {
      events.push("pending");
      binding = b;
      await pendingWait;
      return structuredClone(pending);
    },
    async open(_b, c, ctx, signal) {
      events.push("open");
      expect(c).toEqual(credentials);
      contexts.push(ctx.operationId);
      if (openWait)
        await Promise.race([
          openWait,
          new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
      if (signal?.aborted)
        throw Object.assign(signal.reason, { guardianStopped: true });
      return {
        async command(action) {
          if (action === "inventory")
            return { commits: [], deletions: [], pending: [], complete: true };
          if (action === "checkpoint") {
            pending = [];
            return;
          }
          if (action === "observation-digest") return "a".repeat(64);
        },
        async read() {
          return new Uint8Array();
        },
        async *stream() {},
        async write() {},
        async close() {
          events.push("close");
        },
      };
    },
  };
  const vault = {
    async put(v: unknown, reference = randomUUID()) {
      events.push("put");
      if (failPut) throw new Error("private-password storage failed");
      secrets.set(reference, v);
      return reference;
    },
    async get<T>(r: string) {
      events.push("get");
      if (failGet) throw new Error("private-account storage failed");
      return (secrets.get(r) ?? null) as T | null;
    },
    async remove(r: string) {
      events.push("remove");
      if (failRemove) throw new Error("private-password removal failed");
      secrets.delete(r);
    },
  };
  const path = join(root, "direct.json");
  const options = {
    path,
    appDir: root,
    registry,
    library,
    busy: () => busy,
    vault,
    native,
    quota,
    sessions: (): Array<{
      id: string;
      transcriptFinalized?: boolean;
      files?: { wav?: string };
    }> => sessions.snapshot().sessions,
    now: () => clock,
    write: (p: string, v: unknown) => {
      if (failWrite) throw new Error("private-password disk failed");
      atomicWriteJson(p, v);
    },
  };
  const controls = new DirectSmbConnections(options);
  return {
    root,
    path,
    library,
    registry,
    controls,
    secrets,
    events,
    contexts,
    native,
    options,
    binding: () => binding,
    clock: (n: number) => (clock = n),
    busy: (v: boolean) => (busy = v),
    failPut: (v: boolean) => (failPut = v),
    failGet: (v: boolean) => (failGet = v),
    failRemove: (v: boolean) => (failRemove = v),
    failWrite: (v: boolean) => (failWrite = v),
    failPreference: (v: boolean) => (failPreference = v),
    pending: (v: PendingRemoteTransaction[]) => (pending = v),
    pendingWait: (p?: Promise<void>) => (pendingWait = p),
    probeWait: (p?: Promise<void>) => (probeWait = p),
    openWait: (p?: Promise<void>) => (openWait = p),
    destination: (id: string | null) => (destination = id),
  };
}
async function connect(f: ReturnType<typeof fixture>) {
  const r = await f.controls.test(endpoint, credentials);
  return (
    await f.controls.connect({
      name: "Protected NAS",
      receipt: r.receipt,
      create: false,
    })
  ).connections[0]!;
}
test("protects credentials before awaited native initialization and activates only the validated cache", async () => {
  const f = fixture();
  let finish!: () => void;
  f.pendingWait(new Promise((resolve) => (finish = resolve)));
  const tested = await f.controls.test(endpoint, credentials);
  const pending = f.controls.connect({
    name: "Protected NAS",
    receipt: tested.receipt,
    create: false,
  });
  await Bun.sleep(1);
  expect(f.registry.currentId()).toBeUndefined();
  expect(f.events).toEqual(["probe", "probe", "put", "pending"]);
  finish();
  const state = await pending;
  const c = state.connections[0]!;
  expect(f.registry.currentId()).toBe(c.id);
  expect(f.library.recoveryTransactions()).toEqual([]);
  expect(f.secrets.size).toBe(1);
  const publicText = JSON.stringify(state);
  for (const s of [
    "private-account",
    "private-password",
    "credentialRef",
    "serverGuid",
    f.root,
  ])
    expect(publicText).not.toContain(s);
  expect(readFileSync(f.path, "utf8")).not.toContain("private-password");
});
test("receipts expire at five minutes, are single use and cannot race reconnects", async () => {
  const f = fixture(),
    r = await f.controls.test(endpoint, credentials);
  f.clock(r.expiresAt);
  await expect(
    f.controls.connect({ name: "NAS", receipt: r.receipt, create: false }),
  ).rejects.toMatchObject({ code: "receipt-expired" });
  f.clock(1000);
  const t = await f.controls.test(endpoint, credentials);
  await f.controls.connect({ name: "NAS", receipt: t.receipt, create: false });
  await expect(
    f.controls.connect({ name: "NAS", receipt: t.receipt, create: false }),
  ).rejects.toMatchObject({ code: "receipt-expired" });
});
test("all reused controls require the exact generation and stale controls preserve preference and secret", async () => {
  const f = fixture(),
    c = await connect(f),
    stale = randomUUID();
  await expect(f.controls.rename(c.id, stale, "Changed")).rejects.toMatchObject(
    { code: "stale-generation" },
  );
  await expect(f.controls.enable(c.id, stale, false)).rejects.toMatchObject({
    code: "stale-generation",
  });
  await expect(f.controls.disconnect(c.id, stale)).rejects.toMatchObject({
    code: "stale-generation",
  });
  await expect(f.controls.sync(c.id, stale)).rejects.toMatchObject({
    code: "stale-generation",
  });
  const r = await f.controls.test(endpoint, credentials);
  await expect(
    f.controls.connect({
      name: "Changed",
      receipt: r.receipt,
      create: false,
      connectionId: c.id,
      generation: stale,
    }),
  ).rejects.toMatchObject({ code: "stale-generation" });
  expect(f.registry.currentId()).toBe(c.id);
  expect(f.secrets.size).toBe(1);
});
test("failed protected put or pending initialization rolls back durable state and retires new references", async () => {
  const f = fixture();
  f.failPut(true);
  const r = await f.controls.test(endpoint, credentials);
  await expect(
    f.controls.connect({ name: "NAS", receipt: r.receipt, create: false }),
  ).rejects.toMatchObject({ code: "credential-unavailable" });
  expect(f.controls.snapshot().connections).toEqual([]);
  expect(f.secrets.size).toBe(0);
  f.failPut(false);
  f.pending([
    {
      operationId: randomUUID(),
      deviceId: randomUUID(),
      kind: "read",
      recoverable: true,
      admissions: [],
      extra: "invalid",
    } as PendingRemoteTransaction,
  ]);
  const t = await f.controls.test(endpoint, credentials);
  await expect(
    f.controls.connect({ name: "NAS", receipt: t.receipt, create: false }),
  ).rejects.toBeDefined();
  expect(f.registry.currentId()).toBeUndefined();
  expect(f.secrets.size).toBe(0);
  expect(JSON.parse(readFileSync(f.path, "utf8")).transition).toBeUndefined();
});
test("disconnect credential retirement failures preserve a durable cleanup obligation and local sessions", async () => {
  const f = fixture(),
    c = await connect(f);
  writeFileSync(
    join(f.root, "sessions", "keep.json"),
    JSON.stringify({
      id: "keep",
      title: "Keep",
      transcript: "private meeting",
      transcriptFinalized: true,
    }),
  );
  f.failRemove(true);
  await expect(f.controls.disconnect(c.id, c.generation)).rejects.toMatchObject(
    { code: "recovery-required" },
  );
  expect(f.registry.currentId()).toBeUndefined();
  expect(f.controls.unavailable()).toBe(true);
  const disk = JSON.parse(readFileSync(f.path, "utf8"));
  expect(disk.cleanup).toHaveLength(1);
  expect(f.secrets.has(disk.cleanup[0])).toBe(true);
  expect(readFileSync(join(f.root, "sessions", "keep.json"), "utf8")).toContain(
    "private meeting",
  );
  const restart = new DirectSmbConnections(f.options);
  expect(restart.unavailable()).toBe(true);
});
test("interrupted configuration transitions fail closed without touching their private credential or pending copies", async () => {
  const f = fixture(),
    c = await connect(f),
    disk = JSON.parse(readFileSync(f.path, "utf8"));
  disk.transition = {
    previousConnections: [],
    previousProviderId: null,
    newReference: randomUUID(),
  };
  atomicWriteJson(f.path, disk);
  const before = f.events.slice(),
    restart = new DirectSmbConnections(f.options);
  expect(restart.unavailable()).toBe(true);
  await expect(restart.ready()).rejects.toMatchObject({
    code: "recovery-required",
  });
  expect(f.events).toEqual(before);
  expect(f.secrets.size).toBe(1);
});
test("eight memory receipts and connections are hard bounds rather than silently replacing reviewed receipts", async () => {
  const f = fixture();
  for (let i = 0; i < 8; i++) await f.controls.test(endpoint, credentials);
  await expect(f.controls.test(endpoint, credentials)).rejects.toMatchObject({
    code: "bounds-exceeded",
  });
  f.clock(301000);
  for (let i = 0; i < 8; i++) {
    f.destination(randomUUID());
    await connect(f);
  }
  f.destination(randomUUID());
  const r = await f.controls.test(endpoint, credentials);
  await expect(
    f.controls.connect({ name: "NAS", receipt: r.receipt, create: false }),
  ).rejects.toMatchObject({ code: "bounds-exceeded" });
  expect(f.secrets.size).toBe(8);
});
test("pending original recovery never creates fresh operation contexts and backoff is capped at one hour", async () => {
  const f = fixture(),
    c = await connect(f),
    job = {
      operationId: randomUUID(),
      deviceId: randomUUID(),
      kind: "publish" as const,
      recoverable: false,
      admissions: [],
    };
  f.pending([job]);
  await f.controls.sync(c.id, c.generation);
  expect(f.contexts).toEqual([]);
  let state = f.controls.snapshot().connections[0]!;
  expect(state.error?.code).toBe("recovery-required");
  for (let i = 0; i < 29; i++) {
    f.clock(state.progress.nextRetryAt!);
    await f.controls.tick();
    state = f.controls.snapshot().connections[0]!;
  }
  expect(state.progress.nextRetryAt! - 31000).toBeLessThanOrEqual(31 * 3600000);
  const disk = JSON.parse(readFileSync(f.path, "utf8"));
  expect(disk.connections[0].retryAt - f.options.now()).toBe(3600000);
  expect(disk.connections[0].failures).toBeLessThanOrEqual(30);
});
test("failed credential resolution is sanitized and does not leak fresh contexts indefinitely after uncertain startup", async () => {
  const f = fixture(),
    c = await connect(f);
  f.failGet(true);
  await f.controls.sync(c.id, c.generation);
  expect(f.events.filter((e) => e === "open")).toHaveLength(0);
  expect(JSON.stringify(f.controls.snapshot())).not.toContain(
    "private-account",
  );
});

test("public capability security reflects the reviewed negotiated session", async () => {
  const f = fixture(),
    c = await connect(f);
  expect(c.capabilities.security).toBe("encrypted");
  expect(c.capabilities.encrypted).toBe(true);
});
test("renaming or disabling a direct connection preserves a different selected connector", async () => {
  const f = fixture(),
    c = await connect(f);
  const other = { id: "other", name: "Other" } as any;
  f.registry.register(other.id, () => other);
  f.registry.activate(other.id);
  const renamed = await f.controls.rename(c.id, c.generation, "New NAS");
  expect(renamed.connections[0]!.name).toBe("New NAS");
  expect(f.registry.currentId()).toBe("other");
  await f.controls.enable(c.id, c.generation, false);
  expect(f.registry.currentId()).toBe("other");
});
test("disable aborts and drains an owned synchronization guardian before registry mutation", async () => {
  const f = fixture(),
    c = await connect(f);
  let release!: () => void;
  f.openWait(new Promise((resolve) => (release = resolve)));
  const sync = f.controls.sync(c.id, c.generation);
  for (let i = 0; i < 20 && !f.events.includes("open"); i++) await Bun.sleep(1);
  const disabled = await f.controls.enable(c.id, c.generation, false);
  await sync;
  release();
  expect(disabled.connections[0]!.enabled).toBe(false);
  expect(f.controls.snapshot().syncing).toBe(false);
  expect(f.registry.currentId()).toBeUndefined();
  expect(f.secrets.size).toBe(1);
});
test("original prepared release uses its UUID before any fresh synchronization context", async () => {
  const f = fixture(),
    c = await connect(f),
    deviceId = JSON.parse(
      readFileSync(join(f.root, "library/catalog/state.json"), "utf8"),
    ).deviceId,
    operationId = randomUUID();
  f.pending([
    {
      operationId,
      deviceId,
      kind: "publish",
      recoverable: true,
      releaseOnly: true,
      admissions: [],
    },
  ]);
  await f.controls.sync(c.id, c.generation);
  expect(f.contexts[0]).toBe(operationId);
  expect(f.contexts).toHaveLength(2);
  expect(f.contexts[1]).not.toBe(operationId);
  expect(f.controls.snapshot().connections[0]!.error).toBeNull();
});
test("a failed native pending refresh prevents both provider activation and fresh transactions", async () => {
  const f = fixture(),
    c = await connect(f);
  f.native.pending = async () => {
    throw Error("private-account pending failed");
  };
  await f.controls.sync(c.id, c.generation);
  expect(f.contexts).toHaveLength(0);
  expect(f.controls.snapshot().connections[0]!.error?.code).toBe(
    "transport-unavailable",
  );
  await expect(
    f.controls.enable(c.id, c.generation, true),
  ).rejects.toBeDefined();
  expect(f.contexts).toHaveLength(0);
});
test("cancelled test helper drains and stores no usable receipt", async () => {
  const f = fixture();
  let release!: () => void;
  f.probeWait(new Promise((resolve) => (release = resolve)));
  const tested = f.controls.test(endpoint, credentials);
  await Bun.sleep(1);
  const draining = f.controls.preempt();
  let drained = false;
  void draining.then(() => (drained = true));
  await Bun.sleep(1);
  expect(drained).toBe(false);
  release();
  await expect(tested).rejects.toBeDefined();
  await draining;
  f.probeWait();
  for (let i = 0; i < 8; i++) await f.controls.test(endpoint, credentials);
});
test("the durable transition precedes Keychain put and failed final persistence retains evidence", async () => {
  const f = fixture();
  const original = f.options.vault.put;
  f.options.vault.put = async (value, ref) => {
    expect(
      JSON.parse(readFileSync(f.path, "utf8")).transition.newReference,
    ).toBe(ref);
    return original(value, ref);
  };
  const t = await f.controls.test(endpoint, credentials);
  let writes = 0;
  f.options.write = (path, value) => {
    if (++writes >= 2) throw Error("private-password final disk failure");
    atomicWriteJson(path, value);
  };
  await expect(
    f.controls.connect({ name: "NAS", receipt: t.receipt, create: false }),
  ).rejects.toMatchObject({ code: "recovery-required" });
  expect(f.controls.unavailable()).toBe(true);
  expect(
    JSON.parse(readFileSync(f.path, "utf8")).transition.newReference,
  ).toBeDefined();
  expect(f.registry.currentId()).toBeUndefined();
});
test("configuration rejects 10001 persisted jobs and protects all finalized local recording paths", async () => {
  const f = fixture(),
    c = await connect(f);
  const disk = JSON.parse(readFileSync(f.path, "utf8"));
  for (let i = 0; i < 10001; i++)
    disk.connections[0].jobs[randomUUID()] = { attempts: 0, next: 0 };
  atomicWriteJson(f.path, disk);
  const restarted = new DirectSmbConnections({
    ...f.options,
    sessions: () => [
      {
        id: "keep",
        transcriptFinalized: true,
        files: { wav: join(f.root, "recording.wav") },
      },
    ],
  });
  expect(restarted.unavailable()).toBe(true);
  expect(restarted.protectedLocalPaths()).toEqual([
    join(f.root, "recording.wav"),
  ]);
});
test("explicit empty destination creation follows protected storage and keeps exact v3 public identity", async () => {
  const f = fixture();
  f.destination(null);
  const receipt = await f.controls.test(endpoint, credentials);
  expect(receipt.needsCreation).toBe(true);
  const state = await f.controls.connect({
    name: "NAS",
    receipt: receipt.receipt,
    create: true,
  });
  expect(f.events.indexOf("put")).toBeLessThan(f.events.indexOf("initialize"));
  expect(state.connections[0]!.destinationId).toBe(f.binding()!.destinationId);
  expect(f.binding()!.destinationVersion).toBe(3);
});
test("disconnect and reconnect refuse original pending recovery while disable preserves it", async () => {
  const f = fixture(),
    c = await connect(f),
    job = {
      operationId: randomUUID(),
      deviceId: randomUUID(),
      kind: "read" as const,
      recoverable: false,
      admissions: [],
    };
  f.pending([job]);
  await expect(f.controls.disconnect(c.id, c.generation)).rejects.toMatchObject(
    { code: "recovery-required" },
  );
  const r = await f.controls.test(endpoint, credentials);
  await expect(
    f.controls.connect({
      name: "NAS",
      receipt: r.receipt,
      create: false,
      connectionId: c.id,
      generation: c.generation,
    }),
  ).rejects.toMatchObject({ code: "recovery-required" });
  await f.controls.enable(c.id, c.generation, false);
  expect(f.secrets.size).toBe(1);
  expect(f.controls.snapshot().connections).toHaveLength(1);
  expect(f.binding()!.connectionGeneration).toBe(c.generation);
});
test("registry preference write failure rolls back the direct configuration and removes its protected secret", async () => {
  const f = fixture();
  f.failPreference(true);
  const r = await f.controls.test(endpoint, credentials);
  await expect(
    f.controls.connect({ name: "NAS", receipt: r.receipt, create: false }),
  ).rejects.toMatchObject({ code: "transport-unavailable" });
  expect(f.controls.unavailable()).toBe(false);
  expect(f.secrets.size).toBe(0);
  expect(f.controls.snapshot().connections).toEqual([]);
  expect(f.registry.preferredId()).toBeNull();
  const disk = JSON.parse(readFileSync(f.path, "utf8"));
  expect(disk.transition).toBeUndefined();
  expect(disk.cleanup).toEqual([]);
});
test("a one-shot configuration commit fault restores a previous selected connector and retires the new secret", async () => {
  const f = fixture(),
    other = { id: "other", name: "Other" } as any;
  f.registry.register(other.id, () => other);
  f.registry.activate(other.id);
  let count = 0;
  f.options.write = (path, value) => {
    if (++count === 2) throw Error("Configuration commit failed");
    atomicWriteJson(path, value);
  };
  const r = await f.controls.test(endpoint, credentials);
  await expect(
    f.controls.connect({ name: "NAS", receipt: r.receipt, create: false }),
  ).rejects.toMatchObject({ code: "transport-unavailable" });
  expect(f.registry.currentId()).toBe(other.id);
  expect(f.controls.snapshot().connections).toEqual([]);
  expect(f.controls.unavailable()).toBe(false);
  expect(f.secrets.size).toBe(0);
});
test("an uncertain protected put retains the exact allocated cleanup reference when retirement fails", async () => {
  const f = fixture();
  f.options.vault.put = async (value, ref = randomUUID()) => {
    f.secrets.set(ref, value);
    throw Error("Uncertain Keychain acknowledgement");
  };
  f.failRemove(true);
  const r = await f.controls.test(endpoint, credentials);
  await expect(
    f.controls.connect({ name: "NAS", receipt: r.receipt, create: false }),
  ).rejects.toMatchObject({ code: "recovery-required" });
  const disk = JSON.parse(readFileSync(f.path, "utf8"));
  expect(disk.cleanup).toEqual([...f.secrets.keys()]);
  expect(disk.cleanup).toHaveLength(1);
  expect(f.controls.unavailable()).toBe(true);
});
test("disabled original pending admissions retain local revision and recording protection", async () => {
  const f = fixture(),
    c = await connect(f),
    revisionId = randomUUID();
  f.pending([
    {
      operationId: randomUUID(),
      deviceId: randomUUID(),
      kind: "publish",
      recoverable: false,
      admissions: [
        { meetingId: randomUUID(), revisionId, manifestHash: "a".repeat(64) },
      ],
    },
  ]);
  f.options.sessions = () => [
    {
      id: "keep",
      transcriptFinalized: true,
      files: { wav: join(f.root, "recording.wav") },
    },
  ];
  await f.controls.enable(c.id, c.generation, false);
  expect(f.controls.protectedRevisionIds()).toContain(revisionId);
  expect(f.controls.protectedLocalPaths()).toEqual([
    join(f.root, "recording.wav"),
  ]);
});
test("a failed cached pending query after disable conservatively preserves local recordings", async () => {
  const f = fixture(),
    c = await connect(f);
  f.options.sessions = () => [
    {
      id: "keep",
      transcriptFinalized: true,
      files: { wav: join(f.root, "recording.wav") },
    },
  ];
  await f.controls.enable(c.id, c.generation, false);
  const original = f.native.pending;
  f.native.pending = async () => {
    throw Error("Refresh failed");
  };
  f.registry.activate(c.id);
  await expect(f.library.discover()).rejects.toBeDefined();
  expect(f.controls.protectedLocalPaths()).toEqual([
    join(f.root, "recording.wav"),
  ]);
  f.native.pending = original;
});
test("10000 durable jobs are accepted but the next actual local revision is refused without dropping original jobs", async () => {
  const f = fixture(),
    c = await connect(f),
    disk = JSON.parse(readFileSync(f.path, "utf8"));
  for (let i = 0; i < 10000; i++)
    disk.connections[0].jobs[randomUUID()] = { attempts: 0, next: 0 };
  atomicWriteJson(f.path, disk);
  const registry = new ProviderRegistry({
    path: join(f.root, "preference.json"),
    getLibrary: () => f.library,
  });
  const restarted = new DirectSmbConnections({ ...f.options, registry });
  expect(restarted.unavailable()).toBe(false);
  await restarted.ready();
  registry.restore();
  writeFileSync(
    join(f.root, "sessions", "new-meeting.json"),
    JSON.stringify({
      id: "new-meeting",
      title: "New meeting",
      createdAt: "2026-01-01T00:00:00Z",
      duration: 1,
      language: "en",
      transcript: "Keep the source",
      speakers: [],
      segments: [],
      aiNotes: "",
      summary: "",
      tags: [],
      pinned: false,
      transcriptFinalized: true,
      transcriptionModel: "fixture",
    }),
  );
  await restarted.sync(c.id, c.generation);
  expect(restarted.snapshot().connections[0]!.error?.code).toBe(
    "bounds-exceeded",
  );
  expect(restarted.snapshot().connections[0]!.progress.pending).toBe(10000);
  expect(
    readFileSync(join(f.root, "sessions", "new-meeting.json"), "utf8"),
  ).toContain("Keep the source");
});
test("restart waits for all validated pending caches before restoring the saved provider preference", async () => {
  const f = fixture(),
    c = await connect(f),
    registry = new ProviderRegistry({
      path: join(f.root, "preference.json"),
      getLibrary: () => f.library,
    });
  f.library.selectProvider();
  let resolve!: () => void;
  f.pendingWait(new Promise((r) => (resolve = r)));
  const restarted = new DirectSmbConnections({ ...f.options, registry }),
    ready = restarted.ready();
  await Bun.sleep(1);
  expect(registry.currentId()).toBeUndefined();
  resolve();
  await ready;
  expect(registry.currentId()).toBeUndefined();
  registry.restore();
  expect(registry.currentId()).toBe(c.id);
  expect(f.library.recoveryTransactions()).toEqual([]);
});
test("reconnect changes the generation and retires only the previous protected credential", async () => {
  const f = fixture(),
    c = await connect(f),
    oldRef = [...f.secrets.keys()][0],
    receipt = await f.controls.test(endpoint, credentials);
  const newConnection = (
    await f.controls.connect({
      name: "Reconnected",
      receipt: receipt.receipt,
      create: false,
      connectionId: c.id,
      generation: c.generation,
    })
  ).connections[0]!;
  expect(newConnection.id).toBe(c.id);
  expect(newConnection.generation).not.toBe(c.generation);
  expect(f.secrets.size).toBe(1);
  expect(f.secrets.has(oldRef!)).toBe(false);
  await expect(
    f.controls.enable(c.id, c.generation, false),
  ).rejects.toMatchObject({ code: "stale-generation" });
});
test("an uncertain native open with empty pending fails closed durably and never allocates another operation", async () => {
  const f = fixture(),
    c = await connect(f);
  const operations: string[] = [];
  f.native.open = async (_b, _c, ctx) => {
    operations.push(ctx.operationId);
    throw Error("Uncertain helper startup");
  };
  await f.controls.sync(c.id, c.generation);
  expect(f.controls.snapshot().recoveryRequired).toBe(true);
  expect(f.controls.snapshot().connections[0]!.error?.code).toBe(
    "recovery-required",
  );
  const disk = JSON.parse(readFileSync(f.path, "utf8"));
  expect(disk.connections[0].uncertainty).toEqual({
    operationId: operations[0],
    generation: c.generation,
  });
  await expect(f.controls.tick(true)).rejects.toMatchObject({
    code: "recovery-required",
  });
  await expect(
    f.controls.enable(c.id, c.generation, false),
  ).rejects.toMatchObject({ code: "recovery-required" });
  const restart = new DirectSmbConnections({
    ...f.options,
    registry: new ProviderRegistry({
      path: join(f.root, "preference.json"),
      getLibrary: () => f.library,
    }),
  });
  expect(restart.snapshot().recoveryRequired).toBe(true);
  await restart.ready();
  await expect(restart.sync(c.id, c.generation)).rejects.toMatchObject({
    code: "recovery-required",
  });
  expect(operations).toHaveLength(1);
});
test("failed session close keeps its original durable uncertainty and preempt refuses controls after draining", async () => {
  const f = fixture(),
    c = await connect(f),
    original = f.native.open;
  f.native.open = async (...args) => {
    const session = await original(...args);
    return {
      ...session,
      async close() {
        throw Error("Uncertain guardian reaping");
      },
    };
  };
  await f.controls.sync(c.id, c.generation);
  expect(f.controls.snapshot().recoveryRequired).toBe(true);
  expect(
    JSON.parse(readFileSync(f.path, "utf8")).connections[0].uncertainty
      .operationId,
  ).toBe(f.contexts[0]);
  await expect(f.controls.preempt()).rejects.toMatchObject({
    code: "recovery-required",
  });
  await expect(f.controls.disconnect(c.id, c.generation)).rejects.toMatchObject(
    { code: "recovery-required" },
  );
  expect(f.registry.currentId()).toBe(c.id);
});
test("known stopped startup plus validated absence clears the in-flight receipt and permits bounded retry", async () => {
  const f = fixture(),
    c = await connect(f),
    operations: string[] = [];
  f.native.open = async (_b, _c, ctx) => {
    operations.push(ctx.operationId);
    throw Object.assign(Error("Stopped helper"), {
      guardianStopped: true,
      code: "transport-unavailable",
    });
  };
  await f.controls.sync(c.id, c.generation);
  expect(f.controls.unavailable()).toBe(false);
  expect(
    JSON.parse(readFileSync(f.path, "utf8")).connections[0].uncertainty,
  ).toBeNull();
  await f.controls.tick(true);
  expect(operations).toHaveLength(2);
  expect(f.controls.unavailable()).toBe(false);
});
test("a pre-open durable receipt write failure prevents helper launch and latches recovery", async () => {
  const f = fixture(),
    c = await connect(f);
  f.failWrite(true);
  await f.controls.sync(c.id, c.generation);
  expect(f.events).not.toContain("open");
  expect(f.controls.unavailable()).toBe(true);
});
test("eight in-flight access tests are bounded before launching more credential-bearing helpers", async () => {
  const f = fixture();
  let release!: () => void;
  f.probeWait(new Promise((resolve) => (release = resolve)));
  const tests = Array.from({ length: 8 }, () =>
    f.controls.test(endpoint, credentials),
  );
  await Bun.sleep(1);
  const ninth = f.controls.test(endpoint, credentials).catch((error) => error);
  await Bun.sleep(1);
  release();
  expect(await ninth).toMatchObject({ code: "bounds-exceeded" });
  await Promise.all(tests);
  expect(f.events.filter((e) => e === "probe")).toHaveLength(8);
});
function restartOriginal(
  f: ReturnType<typeof fixture>,
  c: { id: string; generation: string },
  operationId = randomUUID(),
  deviceId = JSON.parse(
    readFileSync(join(f.root, "library/catalog/state.json"), "utf8"),
  ).deviceId,
) {
  const disk = JSON.parse(readFileSync(f.path, "utf8"));
  disk.connections[0].uncertainty = { operationId, generation: c.generation };
  atomicWriteJson(f.path, disk);
  f.pending([
    {
      operationId,
      deviceId,
      kind: "publish",
      recoverable: true,
      releaseOnly: true,
      admissions: [],
    },
  ]);
  const registry = new ProviderRegistry({
      path: join(f.root, "preference.json"),
      getLibrary: () => f.library,
    }),
    restart = new DirectSmbConnections({ ...f.options, registry });
  return { restart, registry, operationId };
}
test("restart uncertainty permits only exact original recovery and that explicit call never starts a fresh cycle", async () => {
  const f = fixture(),
    c = await connect(f),
    r = restartOriginal(f, c);
  await r.restart.ready();
  r.registry.restore();
  expect(r.restart.unavailable()).toBe(false);
  expect(r.restart.snapshot().recoveryRequired).toBe(true);
  const result = await r.restart.sync(c.id, c.generation);
  expect(result.recoveryRequired).toBe(false);
  expect(f.contexts).toEqual([r.operationId]);
  expect(
    JSON.parse(readFileSync(f.path, "utf8")).connections[0].uncertainty,
  ).toBeNull();
});
test("matching absent, copied or wrong-device pending receipts cannot reset original uncertainty", async () => {
  for (const mode of ["absent", "copied", "wrong-device"]) {
    const f = fixture(),
      c = await connect(f),
      r = restartOriginal(f, c);
    if (mode === "absent") f.pending([]);
    if (mode === "copied")
      f.pending([
        {
          operationId: randomUUID(),
          deviceId: randomUUID(),
          kind: "publish",
          recoverable: true,
          releaseOnly: true,
          admissions: [],
        },
      ]);
    if (mode === "wrong-device")
      f.pending([
        {
          operationId: r.operationId,
          deviceId: randomUUID(),
          kind: "publish",
          recoverable: true,
          releaseOnly: true,
          admissions: [],
        },
      ]);
    await r.restart.ready();
    await expect(r.restart.sync(c.id, c.generation)).rejects.toMatchObject({
      code: "recovery-required",
    });
    expect(r.restart.snapshot().recoveryRequired).toBe(true);
    expect(f.contexts).toEqual([]);
    expect(
      JSON.parse(readFileSync(f.path, "utf8")).connections[0].uncertainty
        .operationId,
    ).toBe(r.operationId);
  }
});
test("original recovery leases exclude concurrent mutation and unrelated controls without changing the receipt", async () => {
  const f = fixture(),
    c = await connect(f),
    r = restartOriginal(f, c);
  await r.restart.ready();
  let release!: () => void;
  f.openWait(new Promise((resolve) => (release = resolve)));
  const recovery = r.restart.sync(c.id, c.generation);
  for (let i = 0; i < 20 && !f.events.includes("open"); i++) await Bun.sleep(1);
  await expect(f.library.withMutation(async () => {})).rejects.toThrow(
    "already running",
  );
  await expect(
    r.restart.rename(c.id, c.generation, "Changed"),
  ).rejects.toMatchObject({ code: "recovery-required" });
  release();
  await recovery;
  expect(f.contexts).toEqual([r.operationId]);
  expect(r.restart.snapshot().connections[0]!.name).toBe(c.name);
});
test("a persisted original uncertainty alone does not block local capture after known owned helpers drain", async () => {
  const f = fixture(),
    c = await connect(f),
    r = restartOriginal(f, c);
  await r.restart.ready();
  await r.restart.preempt();
  expect(r.restart.snapshot().recoveryRequired).toBe(true);
  await expect(
    r.restart.enable(c.id, c.generation, false),
  ).rejects.toMatchObject({ code: "recovery-required" });
  expect(f.contexts).toEqual([]);
});

test("known stopped failure while resuming an old original cannot erase uncertainty from newly absent native journals", async () => {
  const f = fixture(),
    c = await connect(f),
    r = restartOriginal(f, c);
  await r.restart.ready();
  f.native.open = async () => {
    f.pending([]);
    throw Object.assign(
      Error("Original startup stopped after journal disappearance"),
      { guardianStopped: true, code: "transport-unavailable" },
    );
  };
  await expect(r.restart.sync(c.id, c.generation)).rejects.toMatchObject({
    code: "recovery-required",
  });
  expect(r.restart.snapshot().recoveryRequired).toBe(true);
  expect(
    JSON.parse(readFileSync(f.path, "utf8")).connections[0].uncertainty
      .operationId,
  ).toBe(r.operationId);
  await expect(r.restart.tick(true)).rejects.toMatchObject({
    code: "recovery-required",
  });
});

test("automatic retries stop after thirty failed attempts while an explicit reviewed sync can attempt once more", async () => {
  const f = fixture(),
    c = await connect(f);
  f.failGet(true);
  await f.controls.sync(c.id, c.generation);
  for (let i = 1; i < 30; i++) {
    f.clock(f.controls.snapshot().connections[0]!.progress.nextRetryAt!);
    await f.controls.tick();
  }
  const before = f.events.filter((e) => e === "get").length;
  f.clock(f.controls.snapshot().connections[0]!.progress.nextRetryAt!);
  await f.controls.tick();
  expect(f.events.filter((e) => e === "get")).toHaveLength(before);
  await f.controls.sync(c.id, c.generation);
  expect(f.events.filter((e) => e === "get")).toHaveLength(before + 1);
});

test("rename preserves the original binding while its native operation still needs recovery", async () => {
  const f = fixture(),
    c = await connect(f);
  f.pending([
    {
      operationId: randomUUID(),
      deviceId: randomUUID(),
      kind: "publish",
      recoverable: false,
      admissions: [],
    },
  ]);
  await expect(
    f.controls.rename(c.id, c.generation, "Changed"),
  ).rejects.toMatchObject({ code: "recovery-required" });
  expect(f.controls.snapshot().connections[0]!.name).toBe("Protected NAS");
  expect(f.binding()!.name).toBe("Protected NAS");
});
test("invalid destination names are refused before credential storage or explicit remote initialization", async () => {
  const f = fixture();
  f.destination(null);
  const receipt = await f.controls.test(endpoint, credentials);
  f.events.length = 0;
  await expect(
    f.controls.connect({
      name: "\ud800",
      receipt: receipt.receipt,
      create: true,
    }),
  ).rejects.toMatchObject({ code: "invalid-input" });
  expect(f.events).toEqual([]);
  expect(f.secrets.size).toBe(0);
});
