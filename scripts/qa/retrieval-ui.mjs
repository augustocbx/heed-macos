#!/usr/bin/env node
/** Production retrieval/browser mechanics QA. Synthetic sources; generator stub is not quality evidence. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as socketServer } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, release } from "node:os";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = process.argv.indexOf("--output");
assert.ok(
  arg >= 0 && process.argv[arg + 1],
  "Usage: retrieval-ui.mjs --output DIR (build production client first; HEED_QA_BUN selects Bun)",
);
const output = resolve(process.argv[arg + 1]),
  bun = process.env.HEED_QA_BUN || "bun";
assert.ok(
  relative(root, output) === ".." || relative(root, output).startsWith("../"),
  "QA evidence must remain outside the checkout",
);
assert.ok(
  existsSync(join(root, "packages/client/dist/index.html")),
  "Build production client first",
);
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "heed-retrieval-ui-"));
for (const name of ["sessions", "recordings", "chat"])
  await mkdir(join(temporary, name));
await writeFile(
  join(temporary, "config.json"),
  JSON.stringify({
    ui_locale: "en",
    automatic_notes: { enabled: false },
    real_time_transcription: false,
  }),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const audio = Buffer.alloc(44 + 64 * 32000);
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
const canary = "EXCLUDED_RETRIEVAL_CANARY_9f21",
  model = "fixture:local",
  prompts = [],
  providerRequests = [],
  checks = [],
  screenshots = [],
  pageErrors = [],
  denied = [],
  owned = [];
const record = (message) => {
  checks.push(message);
  console.log(message);
};
const manifest = {
  schemaVersion: 1,
  harnessSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  gitHead: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  platform: process.platform,
  architecture: process.arch,
  osRelease: release(),
  productionIndexSha256: hash(
    await readFile(join(root, "packages/client/dist/index.html")),
  ),
  fixture: "Public authored EN/PT sources and silent PCM16 WAV",
  generator:
    "Local deterministic evidence-ID stub: mechanics only; no model-quality claim",
  actualASRInvoked: false,
  checks,
  screenshots,
  pageErrors,
  deniedRequests: denied,
  ownedApiProcesses: owned,
  cleanup: { complete: false },
};
const dictionaries = JSON.parse(
  execFileSync(
    bun,
    [
      "-e",
      `import {CHAT_TRANSLATIONS as a} from ${JSON.stringify(join(root, "packages/client/src/lib/translations-chat.ts"))};import {LIBRARY_CHAT_TRANSLATIONS as b} from ${JSON.stringify(join(root, "packages/client/src/lib/translations-library-chat.ts"))};import {RETRIEVAL_TRANSLATIONS as c} from ${JSON.stringify(join(root, "packages/client/src/lib/translations-retrieval.ts"))}; import {STORAGE_TRANSLATIONS as d} from ${JSON.stringify(join(root, "packages/client/src/lib/translations-storage.ts"))};import {SHELL_TRANSLATIONS as e} from ${JSON.stringify(join(root, "packages/client/src/lib/translations-shell.ts"))}; import {CONTENT_TRANSLATIONS as f} from ${JSON.stringify(join(root, "packages/client/src/lib/translations-content.ts"))}; console.log(JSON.stringify({...a,...b,...c,...d,...e,...f}))`,
    ],
    { cwd: root, encoding: "utf8" },
  ),
);
const label = (key, locale = "en") =>
  locale === "en" ? key : dictionaries[key]?.[locale] || key;
let child,
  browser,
  page,
  browserPids = [],
  logBytes = 0,
  logTotalBytes = 0,
  logParts = [];
const mock = createServer(async (req, res) => {
  try {
    providerRequests.push({ method: req.method, path: req.url });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/tags") {
      res.end(JSON.stringify({ models: [{ name: model }] }));
      return;
    }
    let raw = "";
    for await (const part of req) {
      raw += part;
      if (Buffer.byteLength(raw) > 64000)
        throw Error("Unexpected oversized provider request");
    }
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === "/api/show") {
      res.end(
        JSON.stringify({
          details: { family: "llama" },
          model_info: { "llama.context_length": 8192 },
          capabilities: ["completion"],
        }),
      );
      return;
    }
    if (!body.prompt) {
      res.end(JSON.stringify({ done: true, whisper: false, parakeet: false }));
      return;
    }
    const input = JSON.parse(body.prompt);
    assert.ok(
      !JSON.stringify(body).includes(canary),
      "Excluded source leaked into generator payload",
    );
    assert.ok(
      Buffer.byteLength(body.system + body.prompt) <= 5500,
      "Full UTF8 generator input exceeds 5500 bytes",
    );
    assert.equal(body.options.num_ctx, 8192);
    prompts.push({ body, input });
    assert.ok(
      prompts.filter((p) => p.input.question === input.question).length <= 4,
      "More than four generation calls for a question",
    );
    const evidence = input.evidence || [];
    res.end(
      JSON.stringify({
        response: JSON.stringify({
          claims: evidence.length
            ? [
                {
                  text: "Synthetic citation mechanics verified.",
                  evidenceIds: [evidence[0].id],
                },
              ]
            : [],
          notFound: !evidence.length,
        }),
        done: true,
        done_reason: "stop",
      }),
    );
  } catch (error) {
    manifest.providerError = String(error);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
async function freePort() {
  const socket = socketServer();
  await new Promise((r) => socket.listen(0, "127.0.0.1", r));
  const value = socket.address().port;
  await new Promise((r) => socket.close(r));
  return value;
}
const apiPort = await freePort(),
  uiPort = await freePort(),
  trxPort = await freePort(),
  origin = `http://127.0.0.1:${apiPort}`,
  mockOrigin = `http://127.0.0.1:${mock.address().port}`;
const interrupted = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    manifest.interruptedBy = signal;
    interrupted.abort(new Error(`QA interrupted by ${signal}`));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(check, message, cleanup = false) {
  for (let i = 0; i < 300; i++) {
    if (!cleanup && interrupted.signal.aborted) throw interrupted.signal.reason;
    const result = await check();
    if (result) return result;
    await sleep(100);
  }
  throw Error(message || "QA condition timeout");
}
async function request(
  path,
  body,
  method = body === undefined ? "GET" : "POST",
  status = 200,
) {
  const response = await fetch(origin + path, {
    method,
    signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15000)]),
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
function descendants(pid) {
  const table = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const found = [pid];
  for (let i = 0; i < found.length; i++)
    for (const [p, parent] of table)
      if (parent === found[i] && !found.includes(p)) found.push(p);
  return found;
}
async function stop() {
  if (!child) return;
  const entry = owned.at(-1);
  entry.descendants = descendants(child.pid);
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
  entry.exit = child.exitCode ?? child.signalCode;
  for (const pid of entry.descendants)
    assert.throws(
      () => process.kill(pid, 0),
      undefined,
      `Owned process ${pid} survived`,
    );
  child = undefined;
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
      HEED_TRANSCRIPTION_PORT: String(trxPort),
      HEED_TRANSCRIPTION_URL: mockOrigin,
      OLLAMA_HOST: mockOrigin,
      HEED_MODEL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  owned.push({ pid: child.pid, port: apiPort });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      logTotalBytes += data.length;
      const remaining = 2_000_000 - logBytes;
      if (remaining > 0) {
        logParts.push(data.subarray(0, remaining));
        logBytes += Math.min(remaining, data.length);
      }
    });
  let error;
  child.on("error", (e) => (error = e));
  await wait(async () => {
    if (error) throw error;
    if (child.exitCode !== null || child.signalCode !== null)
      throw Error("Owned server exited");
    let response;
    try {
      response = await fetch(origin + "/.well-known/heed-service", {
        signal: AbortSignal.timeout(1000),
      });
    } catch {
      return false;
    }
    if (!response.ok) return false;
    const identity = await response.json();
    assert.equal(identity.checkoutRoot, root);
    assert.equal(identity.pid, child.pid);
    return true;
  }, "Owned API readiness timeout");
}
async function assertNativeSeek(citation) {
  const event = await wait(async () => {
    const latest = await page.evaluate(() => window.__heedQaSeeks.at(-1));
    return latest?.source.endsWith(`/api/sessions/${citation.sessionId}/audio`) && latest;
  }, 'Native audio seeking event was not observed');
  assert.ok(Math.abs(event.seconds - citation.start) < 0.3,
    `Wrong native seek target: ${JSON.stringify({event, expected: citation.start})}`);
  const laterClock = await page.locator('audio').evaluate(node => node.currentTime);
  manifest.audioSeekChecks ??= [];
  manifest.audioSeekChecks.push({sessionId: citation.sessionId, expected: citation.start,
    nativeSeekingSeconds: event.seconds, laterPlaybackSeconds: laterClock});
}
async function shot(name) {
  const filename = name + ".png";
  await page.screenshot({ path: join(output, filename), fullPage: false });
  screenshots.push({
    filename,
    sha256: hash(await readFile(join(output, filename))),
  });
}
const sources = new Map();
async function add(id, title, tags, texts) {
  const wav = join(temporary, "recordings", id + ".wav");
  await writeFile(wav, audio);
  const segments = texts.map((text, index) => ({
    speaker: index % 2 ? "Bruno" : "Ana",
    text,
    start: index + 1,
    end: index + 2,
  }));
  const source = await request("/api/sessions", {
    id,
    title,
    tags,
    duration: 64,
    language: id === "qa-pt" ? "pt" : "en",
    transcriptFinalized: true,
    transcript: texts.join("\n"),
    segments,
    speakers: ["Ana", "Bruno"],
    files: { wav },
  });
  assert.equal(source.id, id);
  sources.set(id, source);
  return source;
}
const scope = { mode: "labels", labels: ["Work", "Reviewed"], match: "any" };
async function thread(id = "qa-en") {
  return request(`/api/sessions/${id}/chat`);
}
async function completed(question, id = "qa-en") {
  return wait(async () => {
    const turn = (await thread(id)).turns.find((t) => t.question === question);
    if (turn?.status === "failed") throw Error(`Turn failed: ${turn.reason}`);
    return turn?.status === "completed" && turn;
  }, "Chat completion timeout");
}
async function libraryCompleted(question, selection = scope) {
  return wait(async () => {
    const turn = (
      await request("/api/library-chat/context", { scope: selection })
    ).thread.turns.find((t) => t.question === question);
    if (turn?.status === "failed")
      throw Error(`Library turn failed: ${turn.reason}`);
    return turn?.status === "completed" && turn;
  });
}
async function meeting(id = "qa-en", locale = "en") {
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto(origin);
  await page.locator('[data-tour="sessions-tab"]').click();
  await page.getByText(sources.get(id).title, { exact: true }).click();
  await page
    .getByRole("button", { name: label("Chat", locale), exact: true })
    .click();
  await page.getByLabel(label("Local chat model", locale)).selectOption(model);
}
async function library(locale = "en") {
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto(origin);
  await page
    .locator("#heed-pages")
    .getByRole("button", { name: label("Meeting chat", locale), exact: true })
    .click();
  await page.getByLabel(label("Local chat model", locale)).selectOption(model);
  await page
    .getByLabel(label("Question across selected meetings", locale))
    .waitFor();
}
async function send(question, kind = "meeting", locale = "en") {
  const field = page.getByLabel(
    label(
      kind === "meeting"
        ? "Question about this meeting"
        : "Question across selected meetings",
      locale,
    ),
  );
  await field.fill(question);
  const submit = page.getByRole("button", {
    name: label("Send question", locale),
    exact: true,
  });
  await wait(() => submit.isEnabled());
  await submit.focus();
  await page.keyboard.press("Enter");
}
try {
  await start();
  await add(
    "qa-en",
    "QA English rollout",
    ["Work"],
    ["Delivery rollout confirmed by Jon.", "Budget review approved for API."],
  );
  await add(
    "qa-pt",
    "QA Português ação",
    ["Work", "Reviewed"],
    ["Entrega ação confirmada por João.", "Revisão técnica da API aprovada."],
  );
  await add(
    "qa-excluded",
    "QA excluded",
    ["Other"],
    [`${canary} Delivery rollout rejected. Entrega ação cancelada.`],
  );
  await add(
    "qa-partial",
    "QA broad evidence",
    ["Broad"],
    Array.from(
      { length: 40 },
      (_, i) =>
        `Broadcap anchor ${i} technical decision. ` +
        "Detailed rollout evidence API schedule commitment. ".repeat(25),
    ),
  );
  // A genuine old durable turn exercises compatibility without fabricated retrieval metadata.
  await stop();
  const legacySource = sources.get("qa-en");
  const now = new Date().toISOString();
  await writeFile(
    join(temporary, "chat", "qa-en.json"),
    JSON.stringify({
      sessionId: "qa-en",
      revision: "legacy-fixture",
      turns: [
        {
          id: "legacy",
          requestId: "legacy",
          question: "Legacy saved question",
          model,
          sourceRevision: legacySource.transcriptRevision,
          status: "completed",
          createdAt: now,
          updatedAt: now,
          attempts: 1,
          answer: {
            claims: [],
            coverage: {
              reviewedChunks: 1,
              totalChunks: 2,
              complete: false,
              answerLimited: false,
            },
          },
        },
      ],
    }),
  );
  await start();
  await wait(
    () =>
      Promise.resolve(
        existsSync(join(temporary, "library/indexes/retrieval/active.json")),
      ),
    "Actual SQLite index did not publish",
  );
  const beforeBrowser = new Set(descendants(process.pid));
  const chrome =
    process.env.HEED_QA_CHROME ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    headless: true,
    ...(existsSync(chrome) ? { executablePath: chrome } : {}),
  });
  manifest.browser = browser.version();
  browserPids = descendants(process.pid).filter(
    (pid) => !beforeBrowser.has(pid),
  );
  manifest.ownedBrowserProcesses = browserPids;
  const context = await browser.newContext({
    viewport: { width: 1100, height: 850 },
  });
  await context.addInitScript((selection) => {
    window.__heedQaSeeks = [];
    document.addEventListener('seeking', (event) => {
      if (event.target instanceof HTMLAudioElement) window.__heedQaSeeks.push({
        source: event.target.currentSrc, seconds: event.target.currentTime,
      });
    }, true);
    localStorage.setItem("heed-setup-skipped", "1");
    localStorage.setItem("heed-tour-done", "1");
    if (!localStorage.getItem("heed-locale"))
      localStorage.setItem("heed-locale", "en");
    if (!localStorage.getItem("heed-library-chat-scope"))
      localStorage.setItem(
        "heed-library-chat-scope",
        JSON.stringify(selection),
      );
  }, scope);
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (
      (["http:", "https:"].includes(url.protocol) && url.origin !== origin) ||
      url.pathname === "/api/transcribe"
    ) {
      denied.push(url.origin + url.pathname);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  context.on("request", (request) => {
    if (
      (request.method() === "POST" &&
        ["/api/library-chat/command"].includes(
          new URL(request.url()).pathname,
        )) ||
      (request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/chat"))
    ) {
      manifest.browserChatCommands ??= [];
      manifest.browserChatCommands.push({
        path: new URL(request.url()).pathname,
        body: request.postDataJSON(),
      });
    }
  });
  context.setDefaultTimeout(15000);
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await meeting();
  await page
    .getByText("Reviewed 1 of 2 transcript chunks.", { exact: true })
    .waitFor();
  record(
    "Legacy durable turn renders its original partial coverage without retrieval migration.",
  );
  await send("Delivery rollout?");
  const first = await completed("Delivery rollout?");
  assert.equal(first.answer.coverage.retrieval.strategy, "lexical");
  assert.equal(first.answer.coverage.retrieval.lookupComplete, true);
  const cite = first.answer.claims[0].citations[0];
  assert.equal(cite.sessionId, "qa-en");
  assert.equal(cite.quote, legacySource.segments[cite.segmentIndex].text);
  let article = page
    .locator("article")
    .filter({ has: page.getByText("Delivery rollout?", { exact: true }) });
  await article.locator("summary").first().click();
  await page.evaluate(() => { window.__heedQaSeeks = []; });
  await article
    .getByRole("button", {
      name: `${cite.speaker} · ${cite.start}s`,
      exact: true,
    })
    .click();
  await page.locator("audio").waitFor();
  await wait(() =>
    page.locator("audio").evaluate((node) => Number.isFinite(node.duration)),
  );
  await assertNativeSeek(cite);
  assert.ok(
    (await page.locator('[aria-current="true"]').allTextContents())
      .join(" ")
      .includes(cite.quote),
  );
  record(
    "Meeting UI sends real scoped request, shows current exact quote and native source seek.",
  );
  await shot("meeting-source-en");
  await meeting();
  const beforeZero = prompts.length;
  await send("zebraunknown?");
  const zero = await completed("zebraunknown?");
  assert.equal(zero.answer.coverage.retrieval.matchedEvidence, 0);
  assert.equal(zero.answer.coverage.retrieval.indexComplete, true);
  assert.equal(zero.answer.coverage.retrieval.lookupComplete, true);
  assert.equal(prompts.length, beforeZero);
  await page
    .getByText(
      label(
        "No lexical matches found. This does not establish that the topic is absent from the selected transcripts.",
      ),
      { exact: true },
    )
    .waitFor();
  record(
    "Full lexical zero makes no generator call and explicitly avoids whole-transcript absence.",
  );
  await meeting("qa-pt");
  await send("Entrega confirmada?");
  const ptMeeting = await completed("Entrega confirmada?", "qa-pt");
  await library();
  await send("Entrega ação?", "library");
  const pt = await libraryCompleted("Entrega ação?");
  assert.ok(pt.snapshot.sources.every((s) => s.sessionId !== "qa-excluded"));
  assert.equal(pt.snapshot.sources.length, 2);
  let libraryArticle = page
    .locator("article")
    .filter({ has: page.getByText("Entrega ação?", { exact: true }) });
  const pcite = pt.answer.claims[0].citations[0];
  await libraryArticle
    .locator("summary")
    .filter({ hasText: `QA Português ação · ${pcite.speaker}` })
    .click();
  assert.equal(pcite.sessionId, "qa-pt");
  await page.evaluate(() => { window.__heedQaSeeks = []; });
  await libraryArticle
    .getByRole("button", {
      name: `QA Português ação · ${pcite.start}s`,
      exact: true,
    })
    .click();
  await page.locator("audio").waitFor();
  await wait(() =>
    page.locator("audio").evaluate((node) => Number.isFinite(node.duration)),
  );
  await assertNativeSeek(pcite);
  assert.ok(
    (await page.locator('[aria-current="true"]').allTextContents())
      .join(" ")
      .includes(pcite.quote),
  );
  record(
    "Library ANY selection excludes canary; PT citation opens authoritative meeting and seeks exact source.",
  );
  await library();
  await page.getByLabel("Combine selected labels").selectOption("all");
  await send("Revisão técnica?", "library");
  const allScope = { ...scope, match: "all" },
    all = await libraryCompleted("Revisão técnica?", allScope);
  assert.deepEqual(
    all.snapshot.sources.map((s) => s.sessionId),
    ["qa-pt"],
  );
  record(
    "Library ALL label scope includes only the shared-label Portuguese source.",
  );
  await shot("library-all-en");
  // Protected accepted edit makes old meeting and library citations historical; new requests use corrected source.
  const source = sources.get("qa-pt");
  const edited = await request("/api/sessions/qa-pt/transcript/commands", {
    expectedTranscriptRevision: source.transcriptRevision,
    expectedTranscriptVersion: source.transcriptVersion,
    requestId: "qa-edit-" + randomUUID(),
    action: "edit",
    target: { kind: "segment", index: 0 },
    text: "Entrega ação confirmada por João corrigido.",
  });
  sources.set("qa-pt", edited);
  await library();
  await page
    .getByText("Historical answer: labels, meetings or transcripts changed.", {
      exact: true,
    })
    .waitFor();
  libraryArticle = page
    .locator("article")
    .filter({ has: page.getByText("Revisão técnica?", { exact: true }) });
  await libraryArticle
    .locator("summary")
    .filter({
      hasText: `QA Português ação · ${all.answer.claims[0].citations[0].speaker}`,
    })
    .click();
  assert.equal(
    await libraryArticle.getByRole("button").last().isDisabled(),
    true,
  );
  await meeting("qa-pt");
  await page
    .getByText(
      "This answer uses an older transcript revision. Its evidence is retained below.",
      { exact: true },
    )
    .waitFor();
  const oldMeeting = page
    .locator("article")
    .filter({ has: page.getByText("Entrega confirmada?", { exact: true }) });
  await oldMeeting.locator("summary").first().click();
  assert.equal(await oldMeeting.getByRole("button").last().isDisabled(), true);
  await send("João corrigido?");
  const corrected = await completed("João corrigido?", "qa-pt");
  assert.equal(corrected.sourceRevision, edited.transcriptRevision);
  assert.equal(
    corrected.answer.claims[0].citations[0].quote,
    edited.segments[0].text,
  );
  const currentArticle = page
    .locator("article")
    .filter({ has: page.getByText("João corrigido?", { exact: true }) });
  await currentArticle.locator("summary").first().click();
  const currentCitation = corrected.answer.claims[0].citations[0];
  await page.evaluate(() => { window.__heedQaSeeks = []; });
  await currentArticle
    .getByRole("button", {
      name: `${currentCitation.speaker} · ${currentCitation.start}s`,
      exact: true,
    })
    .click();
  await wait(() =>
    page.locator("audio").evaluate((node) => Number.isFinite(node.duration)),
  );
  await assertNativeSeek(currentCitation);
  assert.ok(
    (await page.locator('[aria-current="true"]').allTextContents())
      .join(" ")
      .includes(edited.segments[0].text),
  );
  await shot("corrected-current-source-en");
  record(
    "Real guarded #7 edit makes old meeting/library citations stale/disabled; new UI citation opens corrected Unicode source and seeks its preserved time.",
  );
  await meeting("qa-partial");
  await send("Broadcap?");
  const partial = await completed("Broadcap?", "qa-partial");
  assert.ok(
    partial.answer.coverage.retrieval.partialReasons.includes(
      "generation-limit",
    ) ||
      partial.answer.coverage.retrieval.partialReasons.includes(
        "context-budget",
      ),
  );
  assert.equal(partial.answer.coverage.retrieval.generationComplete, false);
  assert.ok(
    partial.answer.coverage.retrieval.suppliedEvidence <
      partial.answer.coverage.retrieval.retrievedEvidence,
  );
  record(
    "Actual long-source retrieval exceeds generation/context budget; displayed counts reflect supplied subset.",
  );
  for (const locale of ["en", "pt-BR", "fr", "de"]) {
    await request("/api/ui-locale", { locale });
    await page.evaluate(
      (locale) => localStorage.setItem("heed-locale", locale),
      locale,
    );
    await meeting("qa-partial", locale);
    await page
      .getByRole("region", { name: label("Retrieval coverage", locale) })
      .waitFor();
    await page.setViewportSize({ width: 360, height: 740 });
    const field = page.getByLabel(label("Question about this meeting", locale));
    await field.scrollIntoViewIfNeeded();
    await field.focus();
    await field.fill("Broadcap");
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .getByRole("button", {
          name: label("Send question", locale),
          exact: true,
        })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    manifest.layoutChecks ??= [];
    const layout = await page.evaluate(() => ({
      locale: localStorage.getItem("heed-locale"),
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll("body *")]
        .filter((n) => n.getBoundingClientRect().right > innerWidth + 1)
        .map((n) => ({
          tag: n.tagName,
          class: n.className,
          text: n.textContent.slice(0, 100),
          right: n.getBoundingClientRect().right,
          width: n.getBoundingClientRect().width,
        }))
        .slice(0, 20),
    }));
    manifest.layoutChecks.push(layout);

    await shot("partial-controls-narrow-" + locale);
    await page
      .getByRole("region", { name: label("Retrieval coverage", locale) })
      .scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -150));
    await shot("partial-coverage-narrow-" + locale);
    record(
      `Native textarea/Tab/submit keyboard and actual partial coverage captured at 360px in ${locale}.`,
    );
    await library(locale);
    await page.setViewportSize({ width: 360, height: 740 });
    const combine = page.getByLabel(label("Combine selected labels", locale));
    await combine.focus();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    assert.equal(await combine.inputValue(), "all");
    await shot("library-scope-narrow-" + locale);
    const libraryField = page.getByLabel(
      label("Question across selected meetings", locale),
    );
    await libraryField.fill("Revisão keyboard");
    const librarySubmit = page.getByRole("button", {
      name: label("Send question", locale),
      exact: true,
    });
    await wait(() => librarySubmit.isEnabled());
    await libraryField.focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await librarySubmit.evaluate((node) => node === document.activeElement),
      true,
    );
    manifest.layoutChecks.push(
      await page.evaluate(() => ({
        locale: localStorage.getItem("heed-locale"),
        kind: "library",
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        overflow: [...document.querySelectorAll("body *")]
          .filter((n) => n.getBoundingClientRect().right > innerWidth + 1)
          .map((n) => ({
            tag: n.tagName,
            text: n.textContent.slice(0, 100),
            class: n.className,
            right: n.getBoundingClientRect().right,
            width: n.getBoundingClientRect().width,
          }))
          .slice(0, 20),
      })),
    );
    await shot("library-controls-narrow-" + locale);
    record(
      `Library native ANY/ALL select and textarea/Tab keyboard captured at 360px in ${locale}.`,
    );
  }
  // Exercise the real storage review without exposing internal cache filenames.
  const pointerPath = join(temporary, "library/indexes/retrieval/active.json");
  const retainedBefore = new Map();
  for (const source of sources.values())
    retainedBefore.set(source.id, {
      sourceSha256: hash(
        await readFile(join(temporary, "sessions", source.id + ".json")),
      ),
      audioSha256: hash(await readFile(source.files.wav)),
      revision: source.transcriptRevision,
      version: source.transcriptVersion,
    });
  const assertRetained = async () => {
    const acceptedSessions = await request("/api/sessions");
    for (const source of sources.values()) {
      const before = retainedBefore.get(source.id);
      assert.equal(
        hash(await readFile(join(temporary, "sessions", source.id + ".json"))),
        before.sourceSha256,
      );
      assert.equal(hash(await readFile(source.files.wav)), before.audioSha256);
      const accepted = acceptedSessions.find(
        (session) => session.id === source.id,
      );
      assert.ok(accepted);
      assert.equal(accepted.transcriptRevision, before.revision);
      assert.equal(accepted.transcriptVersion, before.version);
      assert.deepEqual(accepted.segments, source.segments);
    }
    assert.equal(hash(await readFile(audioPath)), hash(audio));
  };
  manifest.storageReviews = [];
  let storageCard, reviewedStorage;
  for (const locale of ["en", "pt-BR", "fr", "de"]) {
    await request("/api/ui-locale", { locale });
    await page.evaluate(
      (locale) => localStorage.setItem("heed-locale", locale),
      locale,
    );
    const before = await wait(async () => {
      const status = await request("/api/storage");
      return (
        status.reservedBytes === 0 &&
        status.reclaimableCacheBytes > 0 &&
        status.reclaimableCacheBytes === status.categories.indexes &&
        status
      );
    }, "Search cache did not become idle and fully disposable");
    const pointerBefore = hash(await readFile(pointerPath));
    const limit = before.usedBytes - 1;
    assert.ok(limit > 1_048_576);
    const inputValue = String(limit / 1_000_000_000);
    assert.equal(Number(inputValue) * 1_000_000_000, limit);
    await page.goto(origin + "/#settings");
    await page.setViewportSize({ width: 360, height: 740 });
    storageCard = page.getByRole("article", {
      name: label("Local meeting storage", locale),
    });
    const input = storageCard.getByLabel(
      label("Maximum local meeting data (GB)", locale),
    );
    await wait(() => input.isEnabled());
    await input.fill(inputValue);
    const reviewResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/storage/preview" &&
        response.request().method() === "POST",
    );
    await storageCard
      .getByRole("button", { name: label("Review change", locale), exact: true })
      .click();
    const response = await reviewResponse;
    assert.equal(response.status(), 200);
    reviewedStorage = await response.json();
    assert.equal(reviewedStorage.requestedLimit, limit);
    assert.deepEqual(reviewedStorage.removals, []);
    assert.equal(reviewedStorage.derivedCache.bytes, before.categories.indexes);
    assert.ok(reviewedStorage.derivedCache.files > 0);
    const review = storageCard.getByRole("region", {
      name: label("Review storage change", locale),
    });
    const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 9 });
    const expectedSummary = label(
      "Local search data ({count} files, {size} GB) will be cleared and can be rebuilt when space is available. Clearing search data preserves transcripts and audio.",
      locale,
    )
      .replace("{count}", String(reviewedStorage.derivedCache.files))
      .replace(
        "{size}",
        format.format(reviewedStorage.derivedCache.bytes / 1_000_000_000),
      );
    assert.equal(
      await review.getByText(expectedSummary, { exact: true }).count(),
      1,
    );
    assert.equal(await review.getByRole("listitem").count(), 0);
    assert.ok(
      !/index\.sqlite|active\.json|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}/i.test(
        await review.innerText(),
      ),
    );
    await review.scrollIntoViewIfNeeded();
    manifest.layoutChecks.push(
      await page.evaluate(() => ({
        kind: "storage",
        locale: localStorage.getItem("heed-locale"),
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })),
    );
    await shot("storage-cache-review-narrow-" + locale);
    const cancel = review.getByRole("button", {
      name: label("Cancel", locale),
      exact: true,
    });
    await cancel.focus();
    await page.keyboard.press("Enter");
    await review.waitFor({ state: "detached" });
    const cancelled = await request("/api/storage");
    assert.equal(cancelled.limitBytes, before.limitBytes);
    assert.equal(cancelled.categories.indexes, before.categories.indexes);
    assert.equal(hash(await readFile(pointerPath)), pointerBefore);
    await assertRetained();
    manifest.storageReviews.push({
      locale,
      width: 360,
      requestedLimit: limit,
      removals: reviewedStorage.removals,
      derivedCache: reviewedStorage.derivedCache,
      cancelPreserved: true,
    });
    record(
      `Real cache-only storage preview and keyboard Cancel preserve index, sources and every WAV at 360px in ${locale}.`,
    );
  }
  // The last locale performs a separate, explicitly reviewed confirmation.
  const finalPreviewResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/storage/preview" &&
      response.request().method() === "POST",
  );
  await storageCard
    .getByRole("button", { name: label("Review change", "de"), exact: true })
    .click();
  const finalPreview = await finalPreviewResponse;
  assert.equal(finalPreview.status(), 200);
  const finalReview = await finalPreview.json();
  assert.deepEqual(finalReview.removals, []);
  assert.ok(finalReview.derivedCache.bytes > 0);
  const applyResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/storage/settings" &&
      response.request().method() === "POST",
  );
  const confirm = storageCard.getByRole("button", {
    name: label("Confirm storage change", "de"),
    exact: true,
  });
  await confirm.focus();
  await page.keyboard.press("Enter");
  const applied = await applyResponse;
  assert.equal(applied.status(), 200);
  const appliedStorage = await applied.json();
  assert.equal(appliedStorage.limitBytes, finalReview.requestedLimit);
  assert.equal(appliedStorage.categories.indexes, 0);
  assert.equal(existsSync(pointerPath), false);
  await assertRetained();
  record(
    "Explicit real cache-only Confirm retires the complete search generation, retaining all source bytes/guards and every WAV.",
  );
  await request("/api/ui-locale", { locale: "en" });
  await page.evaluate(() => localStorage.setItem("heed-locale", "en"));
  await meeting("qa-pt");
  await send("João corrigido after cache cleanup?");
  const fallback = await completed(
    "João corrigido after cache cleanup?",
    "qa-pt",
  );
  assert.equal(fallback.answer.coverage.retrieval.strategy, "fallback");
  assert.ok(
    fallback.answer.coverage.retrieval.partialReasons.some((reason) =>
      ["index-missing", "index-capacity"].includes(reason),
    ),
  );
  assert.equal(fallback.answer.coverage.retrieval.indexedMeetings, 0);
  assert.equal(fallback.answer.coverage.retrieval.indexComplete, false);
  assert.ok(
    Number.isSafeInteger(fallback.answer.coverage.retrieval.searchedEvidence),
  );
  assert.ok(fallback.answer.coverage.retrieval.searchedEvidence <= 256);
  assert.ok(fallback.answer.coverage.retrieval.suppliedEvidence > 0);
  assert.ok(
    fallback.answer.coverage.retrieval.suppliedEvidence <=
      fallback.answer.coverage.retrieval.searchedEvidence,
  );
  assert.equal(fallback.sourceRevision, edited.transcriptRevision);
  assert.equal(
    fallback.answer.claims[0].citations[0].quote,
    edited.segments[0].text,
  );
  await assertRetained();
  manifest.storageCleanup = {
    reviewed: finalReview.derivedCache,
    mediaRemovals: finalReview.removals,
    limitBytes: appliedStorage.limitBytes,
    sourceAndAudioPreserved: true,
    fallback: fallback.answer.coverage.retrieval,
  };
  record(
    "After cache-only cleanup, real UI chat uses bounded current-source fallback and cites the corrected Unicode text; no real model was invoked.",
  );
  const persisted = await thread("qa-pt");
  await stop();
  await start();
  assert.deepEqual((await thread("qa-pt")).turns, persisted.turns);
  await request("/api/ui-locale", { locale: "en" });
  await page.evaluate(() => localStorage.setItem("heed-locale", "en"));
  await meeting("qa-pt");
  await page.getByText("João corrigido?", { exact: true }).waitFor();
  record(
    "Owned server restart retains durable questions, corrected citations and source guards.",
  );
  manifest.audioFixtures = [];
  for (const source of sources.values()) {
    assert.equal(hash(await readFile(source.files.wav)), hash(audio));
    manifest.audioFixtures.push({
      sessionId: source.id,
      sha256Before: hash(audio),
      sha256After: hash(await readFile(source.files.wav)),
    });
  }
  assert.equal(hash(await readFile(audioPath)), hash(audio));
  manifest.coverage = {
    meeting: first.answer.coverage,
    zero: zero.answer.coverage,
    libraryAny: pt.answer.coverage,
    libraryAll: all.answer.coverage,
    partial: partial.answer.coverage,
  };
  manifest.selectedScopes = {
    any: pt.snapshot.sources.map((s) => s.sessionId),
    all: all.snapshot.sources.map((s) => s.sessionId),
  };
  assert.ok(
    manifest.layoutChecks.every((layout) => layout.scrollWidth <= layout.width),
    "Narrow layout overflows viewport; see layoutChecks",
  );
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(denied, []);
  assert.equal(manifest.providerError, undefined);
  assert.ok(!JSON.stringify(prompts).includes(canary));
  manifest.maxGeneratorInputBytes = Math.max(
    ...prompts.map((p) => Buffer.byteLength(p.body.system + p.body.prompt)),
  );
  manifest.generationContextTokens = [
    ...new Set(prompts.map((p) => p.body.options.num_ctx)),
  ];
  manifest.excludedCanaryAbsent = true;
  manifest.sourceFixtureSha256 = hash(
    JSON.stringify(
      [...sources.values()].map(
        ({
          id,
          title,
          tags,
          segments,
          transcriptRevision,
          transcriptVersion,
        }) => ({
          id,
          title,
          tags,
          segments,
          transcriptRevision,
          transcriptVersion,
        }),
      ),
    ),
  );
  manifest.generatorCalls = prompts.length;
  manifest.generatorQuestions = Object.fromEntries(
    [...new Set(prompts.map((p) => p.input.question))].map((q) => [
      q,
      prompts.filter((p) => p.input.question === q).length,
    ]),
  );
  manifest.audioSha256Before = hash(audio);
  manifest.audioSha256After = hash(await readFile(audioPath));
  manifest.success = true;
} catch (error) {
  manifest.success = false;
  const failure = interrupted.signal.aborted
    ? interrupted.signal.reason
    : error;
  manifest.error = failure.stack || String(failure);
  if (page) await shot("failure").catch(() => {});
  throw failure;
} finally {
  const cleanupErrors = [];
  const clean = async (action) => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
  };
  await clean(async () => {
    await browser?.close();
    for (const pid of browserPids)
      await wait(
        async () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        },
        `Owned browser process ${pid} survived close`,
        true,
      );
  });
  await clean(stop);
  mock.closeAllConnections();
  await clean(() => new Promise((r) => mock.close(r)));
  let rebound = false;
  await clean(async () => {
    const socket = socketServer();
    await new Promise((r, j) => {
      socket.once("error", j);
      socket.listen(apiPort, "127.0.0.1", r);
    });
    await new Promise((r) => socket.close(r));
    rebound = true;
  });
  await clean(() => rm(temporary, { recursive: true, force: true }));
  manifest.cleanup = {
    complete: !cleanupErrors.length,
    apiPortRebound: rebound,
    browserClosed: !browser?.isConnected(),
    ownedTemporaryDirectoryRemoved: !existsSync(temporary),
    errors: cleanupErrors,
  };
  manifest.serverLog = {
    capturedBytes: logBytes,
    totalBytes: logTotalBytes,
    truncated: logTotalBytes > logBytes,
    maximumBytes: 2_000_000,
  };
  await writeFile(join(output, "server.log"), Buffer.concat(logParts));
  await writeFile(
    join(output, "provider-requests.json"),
    JSON.stringify(
      { requests: providerRequests, generation: prompts },
      null,
      2,
    ),
  );
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  assert.deepEqual(cleanupErrors, [], "Owned cleanup failed; see manifest");
}
console.log(
  JSON.stringify({
    output,
    checks: checks.length,
    generatorCalls: prompts.length,
    success: manifest.success,
  }),
);
