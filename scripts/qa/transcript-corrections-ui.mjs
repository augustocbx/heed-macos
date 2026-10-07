#!/usr/bin/env node
/** Production browser/storage QA using owned synthetic EN/PT fixtures and no ASR/providers. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as socketServer } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { tmpdir, release } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argument = process.argv.indexOf("--output");
if (argument < 0 || !process.argv[argument + 1])
  throw Error(
    "Usage: transcript-corrections-ui.mjs --output DIR (build production client first; HEED_QA_BUN selects Bun)",
  );
const output = resolve(process.argv[argument + 1]),
  bun = process.env.HEED_QA_BUN || "bun";
assert.ok(
  existsSync(join(root, "packages/client/dist/index.html")),
  "Build the production client first.",
);
const temporary = await mkdtemp(join(tmpdir(), "heed-corrections-qa-"));
await mkdir(output, { recursive: true });
await mkdir(join(temporary, "sessions"));
await mkdir(join(temporary, "recordings"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const now = "2026-10-06T12:00:00.000Z",
  id = "qa-corrections",
  title = "QA EN/PT corrections";
const segments = [
  {
    speaker: "Ana",
    start: 0,
    end: 3,
    channel: "mic",
    auto: false,
    text: "Jon review API.",
  },
  {
    speaker: "Bruno",
    start: 3,
    end: 6,
    channel: "sys",
    auto: false,
    text: "Joao revisão API.",
  },
];
const audio = Buffer.alloc(44 + 6 * 32000);
audio.write("RIFF");
audio.writeUInt32LE(audio.length - 8, 4);
audio.write("WAVEfmt ", 8);
audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20);
audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(16000, 24);
audio.writeUInt32LE(32000, 28);
audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34);
audio.write("data", 36);
audio.writeUInt32LE(audio.length - 44, 40);
const audioPath = join(temporary, "recordings", "synthetic.wav");
await writeFile(audioPath, audio);
await writeFile(
  join(temporary, "config.json"),
  JSON.stringify({
    ui_locale: "en",
    automatic_notes: { enabled: false },
    real_time_transcription: false,
  }),
);
const fixture = {
  id,
  title,
  createdAt: now,
  duration: 6,
  language: "pt",
  transcript: segments.map((s) => s.text).join("\n"),
  segments,
  speakers: ["Ana", "Bruno"],
  aiNotes: "Synthetic earlier notes",
  summary: "",
  tags: ["QA"],
  pinned: false,
  transcriptFinalized: true,
  transcriptionModel: "synthetic-recognition",
  files: { wav: audioPath },
};
await writeFile(
  join(temporary, "sessions", id + ".json"),
  JSON.stringify(fixture),
);
const dictionary = JSON.parse(
  execFileSync(
    bun,
    [
      "-e",
      `import {TRANSCRIPT_TRANSLATIONS} from ${JSON.stringify(join(root, "packages/client/src/lib/translations-transcript.ts"))};console.log(JSON.stringify(TRANSCRIPT_TRANSLATIONS))`,
    ],
    { cwd: root, encoding: "utf8" },
  ),
);
const label = (key, locale = "en", vars = {}) =>
  (dictionary[key]?.[locale] || key).replace(/\{([^{}]+)\}/g, (whole, key) =>
    Object.hasOwn(vars, key) ? vars[key] : whole,
  );
const providerRequests = [];
const mock = createServer((req, res) => {
  providerRequests.push({ method: req.method, path: req.url });
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify(
      req.url === "/api/tags"
        ? { models: [] }
        : { whisper: false, parakeet: false },
    ),
  );
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
async function availablePort() {
  const socket = socketServer();
  await new Promise((r) => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  return port;
}
const apiPort = await availablePort(),
  uiPort = await availablePort(),
  transcriptionPort = await availablePort();
const origin = `http://127.0.0.1:${apiPort}`,
  mockOrigin = `http://127.0.0.1:${mock.address().port}`;
const log = createWriteStream(join(output, "server.log"));
let child, browser, context, page, spawnError;
const checks = [],
  screenshots = [],
  blockedFonts = [],
  denied = [],
  pageErrors = [];
const manifest = {
  schemaVersion: 1,
  gitHead: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  platform: process.platform,
  architecture: process.arch,
  osRelease: release(),
  macOSVersion:
    process.platform === "darwin"
      ? execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
          encoding: "utf8",
        }).trim()
      : null,
  productionIndexSha256: hash(
    await readFile(join(root, "packages/client/dist/index.html")),
  ),
  checks,
  screenshots,
  actualASRInvoked: false,
  fixture:
    "Authored synthetic EN/PT text and valid silent PCM16 16kHz mono WAV",
  ownedApiProcesses: [],
  cleanup: { complete: false },
  pageErrors,
  deniedRequests: denied,
};
async function stop() {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
    manifest.ownedApiProcesses.at(-1).exit = child.exitCode ?? child.signalCode;
  }
}
async function start() {
  child = spawn(bun, [join(root, "packages/server/server.ts")], {
    cwd: root,
    env: {
      ...process.env,
      HEED_APP_DIR: temporary,
      HEED_RECORDINGS_DIR: join(temporary, "recordings"),
      HEED_API_PORT: String(apiPort),
      PORT: String(apiPort),
      HEED_UI_PORT: String(uiPort),
      HEED_TRANSCRIPTION_PORT: String(transcriptionPort),
      HEED_TRANSCRIPTION_URL: mockOrigin,
      OLLAMA_HOST: mockOrigin,
      HEED_MODEL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  manifest.ownedApiProcesses.push({ pid: child.pid, port: apiPort });
  spawnError = undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw Error("Owned API exited before readiness");
    try {
      const response = await fetch(origin + "/.well-known/heed-service");
      if (response.ok) {
        const identity = await response.json();
        assert.equal(identity.checkoutRoot, root);
        assert.equal(identity.pid, child.pid);
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Owned API readiness timeout");
}
async function request(path, body, method = "POST", status = 200) {
  const response = await fetch(origin + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(
    response.status,
    status,
    `${path}: ${response.status} ${await response.clone().text()}`,
  );
  return response.json();
}
const guard = (s) => ({
  expectedTranscriptRevision: s.transcriptRevision,
  expectedTranscriptVersion: s.transcriptVersion,
});
const saved = async () => {
  const all = await request("/api/sessions", undefined, "GET");
  const value = all.find((s) => s.id === id);
  assert.ok(value);
  return value;
};
const command = (body) =>
  request(`/api/sessions/${id}/transcript/commands`, body);
async function shot(page, name) {
  const filename = name + ".png";
  await page.screenshot({ path: join(output, filename), fullPage: false });
  screenshots.push({
    filename,
    sha256: hash(await readFile(join(output, filename))),
  });
}
async function open(page) {
  await page.goto(origin);
  await page.locator('[data-tour="sessions-tab"]').click();
  await page.getByText(title, { exact: true }).click();
  await page.locator("audio").waitFor();
  await page.waitForFunction(() =>
    Number.isFinite(document.querySelector("audio")?.duration),
  );
}
async function keyboard(page, dialog) {
  for (let n = 0; n < 16; n++) {
    await page.keyboard.press("Tab");
    assert.equal(
      await dialog.evaluate(
        (node) =>
          node.contains(document.activeElement) ||
          document.activeElement === document.body,
      ),
      true,
      "Keyboard focus escaped modal",
    );
  }
}
async function stage(source, suffix) {
  const input = {
    requestId: "qa-stage-" + suffix,
    base: guard(source),
    result: {
      success: true,
      finalized: true,
      duration: 6,
      text: "John final API.\nJoão resultado API.",
      metadata: { language: "pt", model: "synthetic-final" },
      wordCount: 7,
      files: { wav: "", srt: "", txt: "" },
      speakers: ["Ana", "Bruno"],
      segments: [
        { ...segments[0], text: "John final API." },
        { ...segments[1], text: "João resultado API." },
      ],
    },
  };
  return request(`/api/sessions/${id}/transcript/candidates`, input);
}
try {
  await start();
  const chrome =
    process.env.HEED_QA_CHROME ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    ...(existsSync(chrome) ? { executablePath: chrome } : {}),
  });
  manifest.browser = await browser.version();
  context = await browser.newContext({
    viewport: { width: 1100, height: 850 },
  });
  await context.addInitScript(() => {
    localStorage.setItem("heed-setup-skipped", "1");
    localStorage.setItem("heed-tour-done", "1");
    localStorage.setItem("heed-locale", "en");
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname)) {
      blockedFonts.push(url.origin + url.pathname);
      return route.abort("blockedbyclient");
    }
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
      denied.push(url.origin + url.pathname);
      return route.abort("blockedbyclient");
    }
    if (url.pathname === "/api/transcribe") {
      denied.push("Unexpected ASR request");
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(20000);
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await open(page);
  const starting = await saved();
  const topology = (s) =>
    s.segments.map(({ speaker, start, end, channel }) => ({
      speaker,
      start,
      end,
      channel,
    }));
  await page.locator("audio").evaluate((audio) => {
    audio.pause();
    audio.currentTime = 1;
  });
  const opener = page.getByRole("button", {
    name: "Edit segment 2",
    exact: true,
  });
  await opener.click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("João revisão API.\nAção confirmada.");
  await shot(page, "edit-desktop-en");
  assert.equal(
    await page.locator("audio").evaluate((audio) => audio.currentTime),
    1,
  );
  await keyboard(page, dialog);
  await dialog
    .getByRole("button", { name: "Save correction", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  let current = await saved();
  assert.equal(current.segments[1].text, "João revisão API.\nAção confirmada.");
  assert.deepEqual(topology(current), topology(starting));
  assert.equal(current.transcriptVersion, starting.transcriptVersion + 1);
  assert.equal(
    await page.locator("audio").evaluate((audio) => audio.currentTime),
    1,
  );
  await page
    .getByRole("button", { name: "Edit segment 1", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("John review API.");
  await dialog
    .getByRole("button", { name: "Save correction", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  current = await saved();
  assert.equal(current.segments[0].text, "John review API.");
  checks.push(
    "Actual production UI persisted EN/PT Unicode corrections; timing/speakers/channels and audio playhead retained.",
  );
  await page
    .getByRole("button", { name: "Edit segment 1", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("Canceled local text");
  page.once("dialog", (native) => native.accept());
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await saved()).transcript, current.transcript);
  checks.push("Cancel confirmation leaves persisted accepted text unchanged.");
  // An actual second client commits after this editor opens. The editor must keep its draft on 409.
  await page
    .getByRole("button", { name: "Edit segment 1", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("Retained conflicted draft");
  const remote = await command({
    ...guard(current),
    requestId: "qa-second-client",
    action: "edit",
    target: { kind: "segment", index: 0 },
    text: "John newer API.",
  });
  await dialog
    .getByRole("button", { name: "Save correction", exact: true })
    .click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(
    await dialog.getByRole("textbox").inputValue(),
    "Retained conflicted draft",
  );
  assert.equal((await saved()).transcript, remote.transcript);
  await shot(page, "guard-conflict");
  page.once("dialog", (native) => native.accept());
  await dialog
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await open(page);
  checks.push(
    "Actual two-client 409 preserves unsaved editor draft and newer accepted source.",
  );
  const beforePreview = await saved();
  await page
    .getByRole("button", { name: "Find and replace", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Find text", { exact: true }).fill("API");
  await dialog.getByLabel("Replace with", { exact: true }).fill("Interface");
  await dialog
    .getByRole("button", { name: "Preview replacement", exact: true })
    .click();
  await dialog
    .getByRole("checkbox", { name: "I reviewed this replacement", exact: true })
    .waitFor();
  assert.equal((await saved()).transcript, beforePreview.transcript);
  assert.equal(
    await dialog
      .getByRole("button", { name: "Apply replacement", exact: true })
      .isDisabled(),
    true,
  );
  await shot(page, "replace-preview");
  await dialog
    .getByRole("checkbox", { name: "I reviewed this replacement", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Apply replacement", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  current = await saved();
  assert.ok(current.transcript.includes("Interface"));
  checks.push(
    "Literal preview performs no write; explicit review/apply atomically changes matching text.",
  );
  await page
    .getByRole("button", { name: "Recovery history", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  assert.ok((await dialog.textContent()).includes("Jon review API."));
  await shot(page, "history-recovery");
  const lastEdit = current.transcriptEditing.edits.at(-1);
  await dialog.getByRole("combobox").nth(1).selectOption(lastEdit.id);
  await dialog
    .getByRole("button", { name: "Revert this edit", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  current = await saved();
  assert.equal(current.transcript, beforePreview.transcript);
  assert.deepEqual(topology(current), topology(beforePreview));
  assert.equal(current.transcriptEditing.edits.at(-1).kind, "revert");
  checks.push(
    "Original recognition and accepted edits remain visible; explicit safe revert restores only text and keeps seek topology.",
  );
  // Seek remains aligned with the corrected segment. Editing does not seek or resume media.
  await page
    .getByRole("button", { name: current.segments[1].text, exact: true })
    .click();
  await page.locator("audio").evaluate((audio) => audio.pause());
  assert.ok(
    Math.abs(
      (await page.locator("audio").evaluate((audio) => audio.currentTime)) - 3,
    ) < 0.3,
  );
  await page
    .getByRole("button", { name: "Edit segment 2", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await shot(page, "corrected-seek-focus");
  assert.ok(
    Math.abs(
      (await page.locator("audio").evaluate((audio) => audio.currentTime)) - 3,
    ) < 0.3,
  );
  await page.keyboard.press("Escape");
  checks.push(
    "Corrected seek button targets original segment time; editor retains playhead and does not start playback.",
  );
  // Restart only the owned production server, then reload the persisted source/history.
  const durable = await saved();
  await stop();
  await start();
  assert.equal((await saved()).transcriptVersion, durable.transcriptVersion);
  assert.deepEqual(
    (await saved()).transcriptEditing,
    durable.transcriptEditing,
  );
  await open(page);
  checks.push(
    "Owned production server restart preserves exact accepted version/history.",
  );
  let pending = await stage(await saved(), "discard");
  assert.equal(pending.transcriptVersion, durable.transcriptVersion);
  await open(page);
  await page
    .getByRole("button", { name: "Review new transcript", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await page
    .getByText("No pending transcript drafts.", { exact: true })
    .waitFor();
  assert.equal((await saved()).transcript, durable.transcript);
  await page.keyboard.press("Escape");
  checks.push(
    "Real protected candidate API creates durable draft; UI discard preserves accepted corrections/version.",
  );
  pending = await stage(await saved(), "accept");
  await open(page);
  await page
    .getByRole("button", { name: "Review new transcript", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Replace accepted transcript", exact: true })
    .click();
  await page
    .getByText("No pending transcript drafts.", { exact: true })
    .waitFor();
  current = await saved();
  assert.equal(current.transcriptVersion, durable.transcriptVersion + 1);
  assert.equal(current.transcriptionModel, "synthetic-final");
  assert.equal(current.files.wav, audioPath);
  assert.deepEqual(
    current.transcriptEditing.generations.slice(
      0,
      durable.transcriptEditing.generations.length,
    ),
    durable.transcriptEditing.generations,
  );
  assert.deepEqual(
    current.transcriptEditing.edits,
    durable.transcriptEditing.edits,
  );
  await page.keyboard.press("Escape");
  checks.push(
    "Explicit UI replacement installs candidate once, retaining prior corrected generation and saved audio.",
  );
  // A candidate becomes stale after a real speaker rename/source transition.
  pending = await stage(current, "stale");
  const renamed = {
    ...current,
    segments: current.segments.map((s) => ({
      ...s,
      speaker: s.speaker === "Ana" ? "Ana renamed" : s.speaker,
    })),
    speakers: ["Ana renamed", "Bruno"],
  };
  current = await request(
    "/api/sessions?id=" + id,
    {
      segments: renamed.segments,
      speakers: renamed.speakers,
      ...guard(current),
    },
    "PATCH",
  );
  await open(page);
  await page
    .getByRole("button", { name: "Review new transcript", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  assert.equal(
    await dialog
      .getByRole("button", { name: "Replace accepted transcript", exact: true })
      .isDisabled(),
    true,
  );
  await dialog
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await page.keyboard.press("Escape");
  checks.push(
    "Actual accepted speaker rename makes an earlier candidate stale; replace disabled and discard remains available.",
  );
  // Preserve a pending candidate through restart, then remove only the fixture audio reference.
  pending = await stage(await saved(), "locale");
  const beforeRestart = pending.transcriptEditing.candidates;
  await stop();
  await start();
  assert.deepEqual((await saved()).transcriptEditing.candidates, beforeRestart);
  await request("/api/sessions?id=" + id, { files: {} }, "PATCH");
  for (const locale of ["en", "pt-BR", "fr", "de"]) {
    if (locale !== "en") {
      const previous = await saved();
      await request(
        `/api/sessions/${id}/transcript/candidates/${encodeURIComponent(previous.transcriptEditing.candidates[0].id)}/discard`,
        { requestId: "qa-locale-discard-" + locale },
      );
      await stage(await saved(), "locale-" + locale);
    }
    await request("/api/ui-locale", { locale });
    await page.evaluate(
      (locale) => localStorage.setItem("heed-locale", locale),
      locale,
    );
    await openWithoutAudio(page, locale);
    const trigger = page.getByRole("button", {
      name: label("Review new transcript", locale),
      exact: true,
    });
    await trigger.click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", {
        name: label("Replace accepted transcript", locale),
        exact: true,
      })
      .waitFor();
    assert.ok(
      (await dialog.textContent()).includes(
        label("Accepted transcript", locale),
      ),
    );
    await shot(page, "candidate-desktop-" + locale);
    await dialog.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await shot(page, "candidate-comparison-desktop-" + locale);
    await dialog.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.setViewportSize({ width: 360, height: 740 });
    assert.equal(
      await dialog.evaluate(
        (node) =>
          node.getBoundingClientRect().right <= innerWidth &&
          node.getBoundingClientRect().left >= 0,
      ),
      true,
    );
    await keyboard(page, dialog);
    await shot(page, "candidate-narrow-" + locale);
    await dialog.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await shot(page, "candidate-comparison-narrow-" + locale);
    await page.keyboard.press("Escape");
    assert.equal(
      await trigger.evaluate((node) => document.activeElement === node),
      true,
    );
    await page
      .getByRole("button", {
        name: label("Edit segment {number}", locale, { number: 2 }),
        exact: true,
      })
      .click();
    dialog = page.getByRole("dialog");
    const localeText = `João ação ${locale} API.\nEnglish technical vocabulary.`;
    await dialog.getByRole("textbox").fill(localeText);
    await keyboard(page, dialog);
    await shot(page, "editor-narrow-" + locale);
    const beforeLocaleSave = await saved();
    await dialog
      .getByRole("button", {
        name: label("Save correction", locale),
        exact: true,
      })
      .click();
    await dialog.waitFor({ state: "hidden" });
    const localeSaved = await saved();
    assert.equal(localeSaved.segments[1].text, localeText);
    assert.equal(
      localeSaved.transcriptVersion,
      beforeLocaleSave.transcriptVersion + 1,
    );
    assert.deepEqual(topology(localeSaved), topology(beforeLocaleSave));
    await page.setViewportSize({ width: 1100, height: 850 });
  }
  checks.push(
    "Persisted candidate reopens after restart without audio; candidate/editor keyboard, actual EN/PT Unicode save and desktop/narrow screenshots cover all four locales.",
  );
  const final = await saved();
  await writeFile(join(temporary, "accepted.json"), JSON.stringify(final));
  // This is the production v2 validator/import boundary in a second isolated store, not provider synchronization.
  const portableScript = `import assert from 'node:assert/strict';import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {portableMeeting,validateMeeting} from ${JSON.stringify(join(root, "packages/server/lib/portable-schema.ts"))};import {sessionFromPortable,preparePortableTranscript} from ${JSON.stringify(join(root, "packages/server/lib/portable-transcript.ts"))};import {SessionTags} from ${JSON.stringify(join(root, "packages/server/lib/session-tags.ts"))};import {AutomaticNotesService} from ${JSON.stringify(join(root, "packages/server/lib/automatic-notes.ts"))};const source=JSON.parse(readFileSync(${JSON.stringify(join(temporary, "accepted.json"))},'utf8'));const payload=validateMeeting(portableMeeting(source,${JSON.stringify(randomUUID())}));assert.equal(payload.schemaVersion,2);const text=JSON.stringify(payload);for(const privateKey of ['candidates','candidateRequestReceipts','baseGuard','requestSignature','transcriptVersion','embeddings','files','notesJobs','transcriptionDiagnostics'])assert.equal(text.includes('"'+privateKey+'"'),false);const dir=${JSON.stringify(join(temporary, "second-store"))};mkdirSync(dir);const store=new SessionTags(dir);const imported=store.commitSource('qa-imported',null,()=>preparePortableTranscript(null,sessionFromPortable(payload,'qa-imported'),source.updatedAt));assert.equal(imported.transcript,source.transcript);assert.equal(imported.transcriptRevision,source.transcriptRevision);assert.equal(imported.transcriptVersion,1);assert.equal(imported.transcriptEditing.candidates.length,0);assert.equal(imported.transcriptEditing.candidateRequestReceipts.length,0);assert.deepEqual(imported.transcriptEditing.edits.map(({requestId,requestSignature,...e})=>e),payload.transcriptHistory.edits);writeFileSync(${JSON.stringify(join(output, "portable-v2.json"))},JSON.stringify(payload,null,2));console.log(JSON.stringify({schemaVersion:2,historyEdits:payload.transcriptHistory.edits.length,generations:payload.transcriptHistory.generations.length,importedVersion:imported.transcriptVersion,privateStateExcluded:true}));`;
  manifest.portable = JSON.parse(
    execFileSync(bun, ["-e", portableScript], {
      cwd: root,
      env: { ...process.env, HEED_APP_DIR: temporary },
      encoding: "utf8",
    }),
  );
  checks.push(
    "Production portable v2 validation/second-store import preserves accepted Unicode/source/history and excludes local candidates/receipts/version.",
  );
  assert.equal(hash(await readFile(audioPath)), hash(audio));
  assert.deepEqual(
    providerRequests.filter(
      (r) =>
        r.method !== "GET" ||
        /generate|chat|pull|transcribe|finalize/.test(r.path),
    ),
    [],
  );
  assert.deepEqual(denied, []);
  assert.deepEqual(pageErrors, []);
  manifest.blockedBaselineFontRequests = blockedFonts;
  manifest.audioUnchanged = true;
  manifest.pageErrors = pageErrors;
  manifest.deniedRequests = denied;
  manifest.providerMutationRequests = 0;
  manifest.success = true;
  console.log(
    JSON.stringify({
      checks: checks.length,
      screenshots: screenshots.length,
      actualASRInvoked: false,
    }),
  );
  async function openWithoutAudio(page, locale) {
    await page.goto(origin);
    await page.locator('[data-tour="sessions-tab"]').click();
    await page.getByText(title, { exact: true }).click();
    await page
      .getByRole("button", {
        name: label("Review new transcript", locale),
        exact: true,
      })
      .waitFor();
  }
} catch (error) {
  manifest.success = false;
  if (page) {
    await page
      .screenshot({ path: join(output, "failure.png"), fullPage: true })
      .catch(() => {});
    manifest.failureUI = await page
      .locator("body")
      .innerText()
      .then((text) => text.slice(0, 8000))
      .catch(() => "Browser closed");
  }
  manifest.error = error.stack || String(error);
  throw error;
} finally {
  await browser?.close();
  await stop();
  await new Promise((r) => mock.close(r));
  log.end();
  await rm(temporary, { recursive: true, force: true });
  const probe = socketServer();
  await new Promise((r, reject) => {
    probe.once("error", reject);
    probe.listen(apiPort, "127.0.0.1", r);
  });
  await new Promise((r) => probe.close(r));
  manifest.cleanup = {
    complete: true,
    ownedApiPortReleased: true,
    temporaryRemoved: true,
  };
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}
