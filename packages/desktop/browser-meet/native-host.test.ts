import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const script = join(import.meta.dir, "native-host.py");
test("native host rejects untrusted origins and refuses oversized input without network", () => {
  expect(spawnSync("/usr/bin/python3", [script, "https://meet.google.com/"]).status).toBe(1);
  const size = Buffer.alloc(4); size.writeUInt32LE(5000);
  expect(spawnSync("/usr/bin/python3", [script, `chrome-extension://${"a".repeat(32)}/`], { input: size }).status).toBe(1);
});
test("native host whitelist rejects meeting content and invalid control state", () => {
  const code = `import runpy\nm=runpy.run_path(${JSON.stringify(script)})\nvalidate=m['validate']\nbase={'app':'meet','detectorId':'browser:uuid','sequence':1,'state':'active','callId':'uuid','capability':'ready'}\nassert validate(base)==base\nfor patch in [{'title':'Private'}, {'app':'zoom'}, {'sequence':True}, {'callId':None}, {'capability':'degraded'}]:\n try:\n  validate(dict(base, **patch))\n  raise AssertionError('unexpected valid report')\n except ValueError: pass\n`;
  const result = spawnSync("/usr/bin/python3", ["-c", code], { encoding: "utf8" });
  expect(result.stderr).toBe(""); expect(result.status).toBe(0);
});
