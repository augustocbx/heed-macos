import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { directSmbResponse } from "./smb-direct-http";
import { DirectSmbConnections } from "./smb-direct-connections";
import { ProviderRegistry } from "./provider-registry";
import { PortableLibrary } from "./portable-library";
import { SessionTags } from "./session-tags";
import type { DirectSmbNative } from "./smb-direct-types";
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
  },
  credentials = {
    username: "private-account",
    password: "private-password",
    domain: "PRIVATE",
  };
function setup() {
  const root = mkdtempSync(join(tmpdir(), "heed-direct-http-"));
  roots.push(root);
  const sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir);
  const library = new PortableLibrary({
      root: join(root, "library"),
      sessions: new SessionTags(sessionsDir),
      sessionsDir,
      quota: { reserve() {}, release() {} },
    }),
    registry = new ProviderRegistry({
      path: join(root, "preference.json"),
      getLibrary: () => library,
    });
  let busy = false;
  const secrets = new Map<string, unknown>();
  const native: DirectSmbNative = {
    async probe() {
      return {
        identity: {
          serverGuid: "1".repeat(32),
          volumeSerial: "12345678",
          volumeCreated: "1234567890abcdef",
          rootId: "1234567890abcdef",
          rootCreated: "1234567890abcdee",
        },
        dialect: "3.1.1",
        authentication: "authenticated",
        security: "encrypted",
        encrypted: true,
        namespaceSafe: true,
        readOnly: false,
        destinationId: "11111111-1111-4111-8111-111111111111",
        destinationVersion: 3,
        empty: false,
      };
    },
    async initialize() {
      throw Error("Not empty");
    },
    async pending() {
      return [];
    },
    async open() {
      throw Error("private-password native failure");
    },
  };
  const connections = new DirectSmbConnections({
    path: join(root, "direct.json"),
    appDir: root,
    registry,
    library,
    busy: () => busy,
    native,
    vault: {
      async put(v, r = randomUUID()) {
        secrets.set(r, v);
        return r;
      },
      async get<T>(r: string) {
        return secrets.get(r) as T;
      },
      async remove(r) {
        secrets.delete(r);
      },
    },
  });
  return {
    connections,
    root,
    registry,
    native,
    busy: (v: boolean) => (busy = v),
  };
}
const request = (
  body?: unknown,
  origin = "http://localhost:3000",
  method = body === undefined ? "GET" : "POST",
) =>
  new Request("http://localhost:3000/api/smb/direct", {
    method,
    headers: { Origin: origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function connection(f: ReturnType<typeof setup>) {
  const tested = await directSmbResponse(
    request({ action: "test", endpoint, credentials }),
    f.connections,
  );
  expect(tested.status).toBe(200);
  const r = await tested.json();
  const result = await directSmbResponse(
    request({
      action: "connect",
      name: "NAS",
      receipt: r.receipt,
      create: false,
    }),
    f.connections,
  );
  expect(result.status).toBe(200);
  return (await result.json()).connections[0];
}
test("desktop origins and methods are protected with no-store on every response", async () => {
  const f = setup();
  for (const [req, status] of [
    [request(undefined, "https://evil.example"), 403],
    [new Request("http://remote.test:3000/api/smb/direct"), 403],
    [request(undefined, "http://localhost:9999"), 403],
    [request(undefined, "http://localhost:3000", "DELETE"), 405],
    [request(), 200],
  ] as const) {
    const r = await directSmbResponse(req, f.connections);
    expect(r.status).toBe(status);
    expect(r.headers.get("cache-control")).toBe("no-store");
  }
});
test("strict action schemas reject omitted or unknown fields without native effects", async () => {
  const f = setup();
  for (const body of [
    { action: "unknown" },
    { action: "test", endpoint, credentials, extra: true },
    { action: "test", endpoint },
    { action: "test", endpoint, credentials: { ...credentials, password: "" } },
    {
      action: "connect",
      name: "NAS",
      receipt: randomUUID(),
      create: false,
      connectionId: randomUUID(),
    },
    { action: "rename", id: randomUUID(), name: "Name" },
    {
      action: "enable",
      id: randomUUID(),
      generation: randomUUID(),
      enabled: "true",
    },
    { action: "disconnect", id: "../", generation: randomUUID() },
    {
      action: "sync",
      id: randomUUID(),
      generation: randomUUID(),
      password: "private-password",
    },
  ]) {
    const r = await directSmbResponse(request(body), f.connections);
    expect(r.status).toBe(400);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).not.toContain("private-password");
  }
  expect(f.registry.currentId()).toBeUndefined();
});
test("test and snapshot HTTP expose only the approved public contract", async () => {
  const f = setup(),
    tested = await directSmbResponse(
      request({ action: "test", endpoint, credentials }),
      f.connections,
    ),
    receipt = await tested.json();
  expect(Object.keys(receipt).sort()).toEqual([
    "capabilities",
    "destinationId",
    "endpoint",
    "expiresAt",
    "needsCreation",
    "receipt",
  ]);
  expect(Object.keys(receipt.capabilities).sort()).toEqual([
    "authentication",
    "dialect",
    "durability",
    "encrypted",
    "read",
    "remoteDeletion",
    "security",
    "write",
  ]);
  const c = await connection(f);
  expect(Object.keys(c).sort()).toEqual([
    "capabilities",
    "destinationId",
    "enabled",
    "endpoint",
    "error",
    "generation",
    "id",
    "name",
    "progress",
  ]);
  const r = await directSmbResponse(request(), f.connections),
    snapshot = await r.json();
  expect(Object.keys(snapshot).sort()).toEqual([
    "connections",
    "recoveryRequired",
    "syncing",
  ]);
  const text = JSON.stringify(snapshot);
  for (const privateValue of [
    "credentialRef",
    "serverGuid",
    "private-account",
    "private-password",
    f.root,
  ])
    expect(text).not.toContain(privateValue);
});
test("stale and busy controls return 409 without changing destination state", async () => {
  const f = setup(),
    c = await connection(f);
  for (const action of ["rename", "enable", "disconnect", "sync"]) {
    const body = {
      action,
      id: c.id,
      generation: randomUUID(),
      ...(action === "rename" ? { name: "Changed" } : {}),
      ...(action === "enable" ? { enabled: false } : {}),
    };
    const r = await directSmbResponse(request(body), f.connections);
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("stale-generation");
  }
  f.busy(true);
  const busy = await directSmbResponse(
    request({
      action: "enable",
      id: c.id,
      generation: c.generation,
      enabled: false,
    }),
    f.connections,
  );
  expect(busy.status).toBe(409);
  expect((await busy.json()).code).toBe("destination-busy");
  expect(f.connections.snapshot().connections[0]!.enabled).toBe(true);
});
test("expired and consumed receipts return a sanitized conflict", async () => {
  const f = setup(),
    r = await directSmbResponse(
      request({
        action: "connect",
        name: "NAS",
        receipt: randomUUID(),
        create: false,
      }),
      f.connections,
    );
  expect(r.status).toBe(409);
  expect((await r.json()).code).toBe("receipt-expired");
});
test("transport errors contain no raw child diagnostics or private account fields", async () => {
  const f = setup();
  f.native.probe = async () => {
    throw Object.assign(
      Error("private-password private-account /private/app"),
      { code: "transport-unavailable", guardianStopped: true },
    );
  };
  const r = await directSmbResponse(
    request({ action: "test", endpoint, credentials }),
    f.connections,
  );
  expect(r.status).toBe(503);
  const body = await r.json();
  expect(Object.keys(body).sort()).toEqual(["code", "error"]);
  expect(body.code).toBe("transport-unavailable");
  expect(JSON.stringify(body)).not.toContain("private-password");
  expect(JSON.stringify(body)).not.toContain("guardianStopped");
});
test("malformed and oversized requests are input errors with no-store", async () => {
  const f = setup();
  for (const body of ["{", "[]", "null", " ".repeat(16385)]) {
    const r = await directSmbResponse(
      new Request("http://localhost:3000/api/smb/direct", {
        method: "POST",
        body,
      }),
      f.connections,
    );
    expect(r.status).toBe(400);
    expect(r.headers.get("cache-control")).toBe("no-store");
  }
});
test("ambiguous duplicate JSON keys are rejected instead of selecting an overwritten endpoint or credential", async () => {
  const f = setup();
  const raw = JSON.stringify({ action: "test", endpoint, credentials }).replace(
    '"action":"test"',
    '"action":"connect","action":"test"',
  );
  const r = await directSmbResponse(
    new Request("http://localhost:3000/api/smb/direct", {
      method: "POST",
      body: raw,
    }),
    f.connections,
  );
  expect(r.status).toBe(400);
  expect(f.registry.currentId()).toBeUndefined();
});
test("valid original uncertainty keeps GET readable and permits only the exact-generation sync recovery action", async () => {
  const f = setup(),
    c = await connection(f);
  await f.connections.sync(c.id, c.generation);
  const get = await directSmbResponse(request(), f.connections);
  expect(get.status).toBe(200);
  expect((await get.json()).recoveryRequired).toBe(true);
  for (const body of [
    { action: "test", endpoint, credentials },
    { action: "connect", name: "NAS", receipt: randomUUID(), create: false },
    { action: "rename", id: c.id, generation: c.generation, name: "Changed" },
    { action: "enable", id: c.id, generation: c.generation, enabled: false },
    { action: "disconnect", id: c.id, generation: c.generation },
    { action: "sync", id: c.id, generation: c.generation },
  ]) {
    const response = await directSmbResponse(request(body), f.connections);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("recovery-required");
  }
  expect(f.connections.snapshot().connections[0]!.id).toBe(c.id);
});
