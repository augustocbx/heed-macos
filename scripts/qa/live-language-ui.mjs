#!/usr/bin/env node
/** Built UI, protected API and FFmpeg with an owned synthetic capture helper. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputIndex = process.argv.indexOf('--output');
if (outputIndex < 0 || !process.argv[outputIndex + 1])
  throw Error('Usage: live-language-ui.mjs --output DIR');
const output = resolve(process.argv[outputIndex + 1]);
assert(!output.startsWith(root + '/'), 'Generated evidence must remain outside the checkout');
const temporary = await mkdtemp(join(tmpdir(), 'heed-language-ui-'));
const source = join(temporary, 'source'),
  app = join(temporary, 'app');
await mkdir(output, { recursive: true });
await mkdir(app);
for (const name of ['server', 'shared', 'client/dist']) {
  await cp(join(root, 'packages', name), join(source, 'packages', name), {
    recursive: true,
    filter: (path) => !path.includes('node_modules') && !path.endsWith('.test.ts'),
  });
}
await cp(join(root, 'config'), join(source, 'config'), { recursive: true });
for (const name of ['package.json', 'VERSION']) await cp(join(root, name), join(source, name));
await writeFile(
  join(app, 'config.json'),
  JSON.stringify({
    automatic_notes: { enabled: false },
    real_time_transcription: true,
    live_speech_language: 'pt',
    ui_locale: 'en',
  }),
);
const bun = process.env.HEED_QA_BUN || join(process.env.HOME, '.bun/bin/bun');
const binary = join(source, 'packages/transcription/native/heed-parakeet/.build/release/heed-syscap');
await mkdir(dirname(binary), { recursive: true });
await writeFile(
  binary,
  `#!${bun}
const channels=process.argv.at(-1)==='both'?2:1;
console.error(JSON.stringify({ready:true,sample_rate:16000,channels,mode:process.argv.at(-1)}));
const pcm=Buffer.alloc(3200*channels);for(let i=0;i<1600;i++)for(let ch=0;ch<channels;ch++)pcm.writeInt16LE(Math.round(3000*Math.sin(i/8+ch)),(i*channels+ch)*2);
setInterval(()=>process.stdout.write(pcm),100);
`,
  { mode: 0o700 },
);
let supported = true,
  usedModel = 'base';
const requests = [],
  errors = [],
  external = [],
  checks = [];
const mock = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  requests.push({ method: req.method, path: req.url, body });
  let result;
  if (req.url === '/api/tags') result = { models: [] };
  else if (req.url === '/transcribe-live') {
    const model = usedModel;
    usedModel = 'tiny';
    result = {
      text: 'Prévia em português',
      language: body.language,
      task: 'transcribe',
      engine: 'mlx',
      model,
      modelIdentity: `mlx:mlx-community/whisper-${model}-mlx`,
      gov: { live_model: 'tiny', interval_ms: 500, changed: model !== 'tiny' },
      segments: [],
    };
  } else if (req.url === '/finalize')
    result = {
      finalized: true,
      duration: 3,
      language: 'pt',
      model: 'fixture-final',
      turns: [{ speaker: 'João', channel: 'sys', text: 'Decisão final em português.', start: 0, end: 3 }],
      embeddings: {},
    };
  else {
    const live = {
      engine: 'mlx',
      model: supported ? usedModel : 'base.en',
      modelIdentity: supported
        ? `mlx:mlx-community/whisper-${usedModel}-mlx`
        : 'mlx:mlx-community/whisper-base.en-mlx',
      modelRevision: null,
      state: 'loaded',
      supportedLanguages: supported ? ['en', 'pt'] : ['en'],
      automatic: { modelSupported: true, pipelineAvailable: true, offered: false },
      mixedLanguage: 'unverified',
      mode: 'chunk',
      adaptiveModels: supported
        ? ['base', 'tiny'].map((model) => ({
            model,
            modelIdentity: `mlx:mlx-community/whisper-${model}-mlx`,
            languages: ['en', 'pt'],
          }))
        : [],
    };
    result = {
      service: 'heed-transcription',
      protocolVersion: 1,
      checkoutRoot: source,
      pid: process.pid,
      ready: true,
      whisper: true,
      pyannote: true,
      warm: true,
      live_tuning: { mode: 'chunk', chunk_s: 2, interval_ms: 500 },
      models: [],
      languageCapabilities: {
        schemaVersion: 1,
        capabilityKey: (supported ? 'a' : 'b').repeat(64),
        live,
        final: {
          ...live,
          engine: 'parakeet',
          model: 'parakeet-v3',
          modelIdentity: 'parakeet:FluidAudio/parakeet-tdt-0.6b-v3',
          supportedLanguages: ['en', 'pt'],
          mode: 'full',
          adaptiveModels: [],
        },
      },
    };
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(result));
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
async function port() {
  const server = createSocket();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
const apiPort = await port(),
  uiPort = await port(),
  transcriptionPort = await port();
const origin = `http://127.0.0.1:${apiPort}`,
  sidecar = `http://127.0.0.1:${mock.address().port}`;
const log = createWriteStream(join(output, 'server.log'));
const child = spawn(bun, [join(source, 'packages/server/server.ts')], {
  cwd: source,
  env: {
    ...process.env,
    PATH: '/opt/homebrew/bin:' + process.env.PATH,
    HEED_APP_DIR: app,
    HEED_RECORDINGS_DIR: join(app, 'recordings'),
    HEED_API_PORT: String(apiPort),
    PORT: String(apiPort),
    HEED_UI_PORT: String(uiPort),
    HEED_TRANSCRIPTION_PORT: String(transcriptionPort),
    HEED_TRANSCRIPTION_URL: sidecar,
    OLLAMA_HOST: sidecar,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.pipe(log);
child.stderr.pipe(log);
let browser;
async function request(path, body) {
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}
async function until(read, accept, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(`Timed out: ${label}`);
}
try {
  await until(
    async () => {
      if (child.exitCode !== null) throw Error('Owned API exited');
      try {
        return (await fetch(origin + '/.well-known/heed-service')).ok;
      } catch {
        return false;
      }
    },
    Boolean,
    'API readiness',
  );
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({
    headless: true,
    ...(existsSync(chrome) ? { executablePath: chrome } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await context.addInitScript(() => {
    localStorage.setItem('heed-setup-skipped', '1');
    localStorage.setItem('heed-tour-done', '1');
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        throw new DOMException('Synthetic QA has no device access', 'NotAllowedError');
      },
    });
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.origin !== origin) {
        external.push(url.origin);
        return route.abort('blockedbyclient');
      }
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  async function navigate(index) {
    const disclosure = page.locator('[aria-controls="heed-pages"]');
    if (await disclosure.isVisible()) {
      if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await disclosure.click();
    }
    await page.locator('#heed-pages > button').nth(index).click();
  }
  await page.goto(origin);
  await page.getByRole('button', { name: 'Start recording', exact: true }).click();
  const active = await until(
    () => request('/api/recording/status'),
    (value) => value.state === 'recording',
    'PT capture',
  );
  assert.equal(active.liveSpeechLanguage, 'pt');
  await until(
    async () => requests.filter((r) => r.path === '/transcribe-live'),
    (value) => value.length >= 2,
    'both-channel previews',
  );
  assert(
    requests
      .filter((r) => r.path === '/transcribe-live')
      .every((r) => r.body.language === 'pt' && r.body.task === 'transcribe'),
  );
  await navigate(4);
  const languageCard = page.locator('article[aria-labelledby="live-speech-language-title"]');
  await languageCard.locator('select').selectOption('en');
  await until(
    () => request('/api/recording/settings'),
    (value) => value.liveLanguage === 'en',
    'saved next language',
  );
  assert.equal((await request('/api/recording/status')).liveSpeechLanguage, 'pt');
  await languageCard.locator('[role="status"]').waitFor();
  assert.match(await languageCard.innerText(), /Active recording: Brazilian Portuguese/);
  await navigate(0);
  await page.getByRole('status').filter({ hasText: 'Provisional live text:' }).waitFor();
  assert.match(
    await page.getByRole('status').filter({ hasText: 'Provisional live text:' }).innerText(),
    /Brazilian Portuguese.*mlx \/ tiny.*Initial model: base/,
  );
  await page.screenshot({ path: join(output, 'active-pt.png') });
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  const completed = await until(
    () => request('/api/recording/status'),
    (value) => value.state === 'completed',
    'final capture',
  );
  assert.equal(completed.session.language, 'pt');
  assert.equal(completed.session.transcript, 'Decisão final em português.');
  const audio = await readFile(completed.session.files.wav);
  assert(audio.length > 44);
  checks.push(
    'actual built PT UI, both-channel guarded preview, compatible runtime model, next language preserves admitted PT, authoritative final source',
  );
  supported = false;
  await request('/api/recording/settings', { enabled: true, liveLanguage: 'pt' });
  await page.getByRole('button', { name: 'Start recording', exact: true }).click();
  const fallback = page.getByRole('button', { name: 'Record final-only (keeps real-time off)', exact: true });
  await fallback.waitFor();
  assert.notEqual((await request('/api/recording/status')).state, 'recording');
  const liveCalls = requests.filter((r) => r.path === '/transcribe-live').length;
  await fallback.click();
  const off = await until(
    () => request('/api/recording/status'),
    (value) => value.state === 'recording',
    'explicit final-only',
  );
  assert.equal(off.realTimeTranscription, false);
  assert.equal(off.liveOptions.effectiveLanguage, null);
  assert.equal((await request('/api/recording/settings')).enabled, false);
  await page.getByRole('status').filter({ hasText: 'Live text is disabled.' }).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 2400));
  assert.equal(requests.filter((r) => r.path === '/transcribe-live').length, liveCalls);
  await page.screenshot({ path: join(output, 'final-only.png') });
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await until(
    () => request('/api/recording/status'),
    (value) => value.state === 'completed',
    'final-only stop',
  );
  checks.push(
    'unsupported .en refuses before capture; explicit final-only saves off and starts normally; no live calls while off',
  );
  await navigate(4);
  await page.setViewportSize({ width: 360, height: 740 });
  for (const locale of ['en', 'pt-BR', 'fr', 'de']) {
    await page.locator('#interface-language').selectOption(locale);
    await until(
      () => request('/api/ui-locale'),
      (value) => value.locale === locale,
      'interface locale',
    );
    await languageCard.locator('select').selectOption('en');
    await until(
      () => request('/api/recording/settings'),
      (value) => value.liveLanguage === 'en',
      'independent speech language',
    );
    await languageCard.scrollIntoViewIfNeeded();
    const bounds = await languageCard.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 361);
    const text = await languageCard.innerText();
    if (locale !== 'en') assert(!text.includes('Live speech language'));
    assert.match(text, /base\.en/);
    assert.match(text, /parakeet-v3/);
    await page.screenshot({ path: join(output, `settings-${locale}.png`) });
    const config = JSON.parse(await readFile(join(app, 'config.json'), 'utf8'));
    assert.equal(config.ui_locale, locale);
    assert.equal(config.live_speech_language, 'en');
    assert.equal(config.real_time_transcription, false);
  }
  assert.deepEqual(errors, []);
  checks.push(
    'four narrow interface locales, separate persisted speech and preview preferences, actual live/final model metadata',
  );
  await writeFile(
    join(output, 'manifest.json'),
    JSON.stringify(
      {
        checks,
        pageErrors: errors,
        deniedExternalOrigins: [...new Set(external)],
        syntheticCapture: true,
        actualInference: false,
        capturedAudioBytes: audio.length,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks: checks.length, pageErrors: errors.length, audioBytes: audio.length }));
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
  await new Promise((resolve) => mock.close(resolve));
  log.end();
  await rm(temporary, { recursive: true, force: true });
  const probe = createSocket();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(apiPort, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
}
