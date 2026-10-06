import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
async function serverFixture(corrupt = false) {
  const root = mkdtempSync(join(tmpdir(), "heed-direct-server-"));
  mkdirSync(join(root, "recordings"));
  if (corrupt)
    writeFileSync(
      join(root, "direct-smb-connections.json"),
      JSON.stringify({
        version: 1,
        connections: [],
        cleanup: [],
        transition: {
          previousConnections: [],
          previousProviderId: null,
          newReference: null,
        },
      }),
    );
  const media = join(root, "recordings", "keep.wav");
  writeFileSync(media, "private local recording");
  const sidecar = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ whisper: true }),
    }),
    reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    }),
    base = `http://127.0.0.1:${reservation.port}`;
  reservation.stop(true);
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../server.ts")],
    {
      cwd: resolve(import.meta.dir, "../../.."),
      env: {
        ...process.env,
        PORT: base.split(":").at(-1)!,
        HEED_API_PORT: base.split(":").at(-1)!,
        HEED_APP_DIR: root,
        HEED_RECORDINGS_DIR: join(root, "recordings"),
        HEED_TRANSCRIPTION_URL: `http://127.0.0.1:${sidecar.port}`,
        OLLAMA_HOST: "http://127.0.0.1:1",
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  return {
    root,
    base,
    media,
    child,
    async ready() {
      for (let i = 0; i < 160; i++) {
        try {
          if ((await fetch(base + "/api/sessions")).ok) return;
        } catch {}
        await Bun.sleep(25);
      }
      throw Error("Isolated direct SMB server did not start");
    },
    async close() {
      child.kill();
      await child.exited;
      sidecar.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("server routes direct and mounted SMB separately with strict local-origin no-store controls", async () => {
  const f = await serverFixture();
  try {
    await f.ready();
    const r = await fetch(f.base + "/api/smb/direct");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({
      recoveryRequired: false,
      syncing: false,
      connections: [],
    });
    expect((await fetch(f.base + "/api/smb")).status).toBe(200);
    const denied = await fetch(f.base + "/api/smb/direct", {
      headers: { Origin: "https://evil.example" },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    const invalid = await fetch(f.base + "/api/smb/direct", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "disconnect", id: "bad" }),
    });
    expect(invalid.status).toBe(400);
    expect(readFileSync(f.media, "utf8")).toBe("private local recording");
  } finally {
    await f.close();
  }
}, 15000);
test("server interrupted private direct transition fails closed and preserves local recordings and journal", async () => {
  const f = await serverFixture(true);
  try {
    await f.ready();
    const r = await fetch(f.base + "/api/smb/direct");
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await r.json()).code).toBe("recovery-required");
    expect(readFileSync(f.media, "utf8")).toBe("private local recording");
    expect(
      JSON.parse(
        readFileSync(join(f.root, "direct-smb-connections.json"), "utf8"),
      ).transition,
    ).toBeDefined();
  } finally {
    await f.close();
  }
}, 15000);
