import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-json";
test("atomic JSON replacement preserves complete records and leaves no transaction artifacts", () => {
 const dir = mkdtempSync(join(tmpdir(), "heed-atomic-test-"));
 try { const path = join(dir, "session.json"); atomicWriteJson(path, { revision: 1, transcript: "Olá" }); atomicWriteJson(path, { revision: 2, transcript: "Hello" }); expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ revision: 2, transcript: "Hello" }); expect(readdirSync(dir)).toEqual(["session.json"]); } finally { rmSync(dir, { recursive: true, force: true }); }
});
