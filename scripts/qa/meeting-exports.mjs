#!/usr/bin/env node
/** Production UI/worker QA with owned data and no permitted external requests. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputIndex = process.argv.indexOf('--output');
if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw Error('Usage: meeting-exports.mjs --output DIR');
const output = resolve(process.argv[outputIndex + 1]);
const require = createRequire(join(root, 'packages/client/package.json'));
const { parseSync } = require('subtitle');
const fixtures = JSON.parse(await readFile(join(root, 'scripts/qa/fixtures/meeting-exports/cases.json'), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'heed-export-qa-'));
await mkdir(output, { recursive: true });
await mkdir(join(temporary, 'sessions')); await mkdir(join(temporary, 'recordings'));
const audio = Buffer.alloc(44 + 32000); audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(32000, 40);
const audioPath = join(temporary, 'recordings', 'synthetic.wav'); await writeFile(audioPath, audio);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const beforeAudio = hash(audio);
const now = '2026-10-06T12:00:00.000Z';
const task = { id: 'export-task', revision: 'export-task-rev', sessionId: 'qa-short', meetingTitle: 'QA short', suggestionId: 'fixture-suggestion', sourceRevision: '0'.repeat(64), evidence: [], kind: 'explicit', title: fixtures.task, description: 'Public synthetic task, completed.', assignee: 'João', dueDate: '2026-10-08', status: 'completed', completedAt: now, createdAt: now, updatedAt: now };
await writeFile(join(temporary, 'tasks.json'), JSON.stringify({ version: 1, tasks: [task], reviews: {}, decisions: {} }));
await writeFile(join(temporary, 'config.json'), JSON.stringify({ ui_locale: 'en', automatic_notes: { enabled: false }, real_time_transcription: false }));
for (const kind of ['short', 'portuguese', 'long', 'untimed']) {
 const segments = kind === 'long' ? Array.from({ length: 25 }, (_, i) => ({ speaker: 'LongName'.repeat(18), start: i * 4, end: i * 4 + 4, text: 'Ação, João and English commitments. '.repeat(4) })) : kind === 'untimed' ? [] : fixtures[kind];
 const session = { id: `qa-${kind}`, title: `QA ${kind}`, summary: '', createdAt: now, transcript: segments.map(segment => segment.text).join('\n'), segments, speakers: [...new Set(segments.map(segment => segment.speaker))], duration: kind === 'long' ? 100 : 13, language: kind === 'portuguese' ? 'pt' : 'en', aiNotes: fixtures.notes, tags: [], pinned: false, transcriptFinalized: true, files: { wav: audioPath, srt: 'PRIVATE_EXPORT_SENTINEL' }, speakerEmbeddings: { PRIVATE_EXPORT_SENTINEL: [1, 2] } };
 await writeFile(join(temporary, 'sessions', `${session.id}.json`), JSON.stringify(session));
}
const providerRequests = [];
const mock = createServer((req, res) => { providerRequests.push({ method: req.method, path: req.url }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/api/tags' ? { models: [] } : { whisper: false, parakeet: false })); });
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
async function port() { const server = createSocket(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
const apiPort = await port(), uiPort = await port(), transcriptionPort = await port();
const origin = `http://127.0.0.1:${apiPort}`, mockOrigin = `http://127.0.0.1:${mock.address().port}`;
const log = createWriteStream(join(output, 'server.log'));
const child = spawn(process.env.HEED_QA_BUN || 'bun', [join(root, 'packages/server/server.ts')], { cwd: root, env: { ...process.env, HEED_APP_DIR: temporary, HEED_RECORDINGS_DIR: join(temporary, 'recordings'), HEED_API_PORT: String(apiPort), PORT: String(apiPort), HEED_UI_PORT: String(uiPort), HEED_TRANSCRIPTION_PORT: String(transcriptionPort), HEED_TRANSCRIPTION_URL: mockOrigin, OLLAMA_HOST: mockOrigin, HEED_MODEL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(log); child.stderr.pipe(log);
let browser;
const denied = [], pageErrors = [], artifacts = [], checks = [];
async function request(path, body, method = 'POST') { const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); assert.equal(response.ok, true, `${path}: ${response.status} ${await response.clone().text()}`); return response.json(); }
async function ready() { for (let attempt = 0; attempt < 100; attempt++) { if (child.exitCode !== null) throw Error('Fixture API exited before readiness'); try { const response = await fetch(origin + '/.well-known/heed-service'); if (response.ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Fixture API readiness timeout'); }
try {
 await ready();
 const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
 const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, acceptDownloads: true });
 await context.addInitScript(() => {
  localStorage.setItem('heed-setup-skipped', '1'); localStorage.setItem('heed-tour-done', '1'); localStorage.setItem('heed-locale', 'en');
  const state = window.__exportQA = { activeWorkers: 0, workers: 0, terminated: 0, blobs: new Set() };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker { constructor(...args) { super(...args); state.activeWorkers++; state.workers++; } terminate() { if (!this.closed) { this.closed = true; state.activeWorkers--; state.terminated++; } return super.terminate(); } };
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => { const url = create(blob); state.blobs.add(url); return url; };
  URL.revokeObjectURL = url => { state.blobs.delete(url); return revoke(url); };
 });
 await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.protocol === 'http:' || url.protocol === 'https:') { if (url.origin !== origin) { denied.push(url.origin + url.pathname); return route.abort('blockedbyclient'); } } return route.continue(); });
 const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
 await page.goto(origin); await page.locator('[data-tour="sessions-tab"]').click();
 async function open(kind) { const row = page.getByText(`QA ${kind}`, { exact: true }).locator('../..'); const button = row.getByRole('button', { name: 'More options', exact: true }); await button.click(); await page.getByRole('button', { name: 'Export PDF or subtitles…', exact: true }).click(); await page.getByRole('dialog').waitFor(); return button; }
 async function preview() { const response = page.waitForResponse(response => response.url().endsWith('/export-preview')); await page.getByRole('button', { name: 'Preview selected content', exact: true }).click(); const value = await (await response).json(); assert.ok(value.snapshot, JSON.stringify(value)); await page.getByRole('region', { name: 'Export preview', exact: true }).waitFor(); return value; }
 async function acknowledge() { for (const label of ['I reviewed these notes', 'I reviewed the selected tasks', 'I understand the selected content may be outdated']) { const checkbox = page.getByRole('checkbox', { name: label, exact: true }); if (await checkbox.count()) await checkbox.check(); } }
 async function save(name, snapshot) { await acknowledge(); await page.getByRole('button', { name: 'Generate export', exact: true }).click(); await page.getByRole('button', { name: 'Save export', exact: true }).waitFor({ timeout: 90000 }); const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Save export', exact: true }).click(); const download = await downloading; const filename = `${name}.${snapshot.format}`; await download.saveAs(join(output, filename)); const bytes = await readFile(join(output, filename)); assert.ok(bytes.length > 20); const json = `${name}.json`; await writeFile(join(output, json), JSON.stringify(snapshot, null, 2)); artifacts.push({ name, filename, preview: json, bytes: bytes.length, sha256: hash(bytes) }); assert.ok(!bytes.includes(Buffer.from('PRIVATE_EXPORT_SENTINEL'))); return bytes; }
 for (const [name, kind, format, scope] of [['short', 'short', 'pdf', 'transcript'], ['long', 'long', 'pdf', 'transcript'], ['notes', 'untimed', 'pdf', 'notes'], ['tasks', 'short', 'pdf', 'tasks'], ['portuguese', 'portuguese', 'pdf', 'transcript'], ['short-srt', 'short', 'srt', 'transcript'], ['short-vtt', 'short', 'vtt', 'transcript'], ['portuguese-vtt', 'portuguese', 'vtt', 'transcript']]) {
  await open(kind); const dialog = page.getByRole('dialog'); await dialog.getByRole('combobox').selectOption(format);
  if (format === 'pdf') { const checkboxes = dialog.locator('fieldset input[type=checkbox]'); await checkboxes.nth(0).setChecked(scope === 'transcript'); await checkboxes.nth(1).setChecked(scope === 'notes'); for (let index = 4; index < await checkboxes.count(); index++) await checkboxes.nth(index).setChecked(scope === 'tasks'); }
  const frozen = await preview(); assert.equal(frozen.selection.transcript, scope === 'transcript'); assert.equal(frozen.selection.notes, scope === 'notes'); const bytes = await save(name, frozen);
  if (format !== 'pdf') { const parsed = parseSync(bytes.toString('utf8')).filter(node => node.type === 'cue'); assert.equal(parsed.length, frozen.snapshot.segments.filter(segment => segment.text.trim()).length); for (const node of parsed) assert.ok(node.data.end > node.data.start); if (format === 'vtt') {
   const cues = await page.evaluate(async text => { const video = document.createElement('video'), element = document.createElement('track'), url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' })); element.src = url; element.kind = 'subtitles'; video.append(element); document.body.append(video); element.track.mode = 'hidden'; try { await new Promise((resolve, reject) => { element.onload = resolve; element.onerror = () => reject(Error('Native VTT parser rejected output')); }); return [...element.track.cues].map(cue => ({ start: cue.startTime, end: cue.endTime, text: cue.getCueAsHTML().textContent })); } finally { video.remove(); URL.revokeObjectURL(url); } }, bytes.toString('utf8'));
   assert.equal(cues.length, parsed.length); for (let index = 0; index < cues.length; index++) { const expected = parsed[index].data; assert.equal(cues[index].start, expected.start / 1000); assert.equal(cues[index].end, expected.end / 1000); const decoded = await page.evaluate(text => { const node = document.createElement('textarea'); node.innerHTML = text; return node.value; }, expected.text); assert.equal(cues[index].text, decoded); } await writeFile(join(output, `${name}-native-cues.json`), JSON.stringify(cues, null, 2));
  } }
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
 }
 checks.push('production PDF/SRT/VTT generation, literal native VTT decoding, selected scopes');
 assert.deepEqual(await page.evaluate(() => ({ active: window.__exportQA.activeWorkers, blobs: window.__exportQA.blobs.size })), { active: 0, blobs: 0 });
 checks.push('owned workers terminate and download/VTT Blob URLs are revoked');
 // Scope changes clear the preview; Escape returns focus to the persistent row control.
 const trigger = await open('short'); await page.getByRole('combobox').selectOption('vtt'); await preview(); await page.getByRole('dialog').getByRole('checkbox', { name: 'Speaker labels', exact: true }).uncheck(); assert.equal(await page.getByRole('region', { name: 'Export preview', exact: true }).count(), 0);
 await page.keyboard.press('Escape'); assert.equal(await trigger.evaluate(node => document.activeElement === node), true); checks.push('scope invalidation and Escape focus return');
 await open('short'); await preview(); await acknowledge(); const sessions = await request('/api/sessions', undefined, 'GET'); const session = sessions.find(item => item.id === 'qa-short'); await request('/api/sessions?id=qa-short', { title: 'QA short changed' }, 'PATCH'); await page.getByRole('button', { name: 'Generate export', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Content changed' }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Save export', exact: true }).count(), 0); await request('/api/sessions?id=qa-short', { title: session.title }, 'PATCH'); await page.keyboard.press('Escape'); checks.push('actual validation conflict clears old review and Save');
 // The API validates before the renderer starts; a later title change cannot mutate the frozen bytes.
 await open('short'); const frozen = await preview();
 await page.route('**/export-validate', async route => { const response = await route.fetch(); assert.equal(response.status(), 200); await request('/api/sessions?id=qa-short', { title: 'QA short after validation' }, 'PATCH'); await route.fulfill({ response }); });
 await save('frozen-after-validation', frozen); await page.unroute('**/export-validate'); await page.keyboard.press('Escape'); await request('/api/sessions?id=qa-short', { title: session.title }, 'PATCH'); checks.push('post-validation edits leave the downloaded snapshot frozen');
 // Cancel an actual owned worker while its long PDF is generating, then verify UI and cleanup.
 await open('long'); await preview(); await page.getByRole('button', { name: 'Generate export', exact: true }).click(); await page.getByRole('status').filter({ hasText: 'Generating export...' }).waitFor(); await page.getByRole('button', { name: 'Cancel generation', exact: true }).click(); assert.equal(await page.evaluate(() => window.__exportQA.activeWorkers), 0); assert.equal(await page.getByRole('button', { name: 'Save export', exact: true }).count(), 0); await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Record', exact: true }).click(); await page.locator('[data-tour="sessions-tab"]').click(); checks.push('cancel terminates a live PDF worker and leaves navigation responsive');
 for (const [locale, title] of [['en', 'Export PDF or subtitles'], ['pt-BR', 'Exportar PDF ou legendas'], ['fr', 'Exporter en PDF ou sous-titres'], ['de', 'PDF oder Untertitel exportieren']]) {
  await request('/api/ui-locale', { locale }); await page.evaluate(locale => localStorage.setItem('heed-locale', locale), locale); await page.reload(); await page.locator('[data-tour="sessions-tab"]').click(); const button = page.locator('button').filter({ hasText: '⋯' }).first(); await button.click(); await page.locator('button').filter({ hasText: title + '…' }).click(); const dialog = page.getByRole('dialog', { name: title, exact: true }); await dialog.waitFor(); await page.setViewportSize({ width: 360, height: 740 }); assert.equal(await dialog.evaluate(node => node.getBoundingClientRect().right <= innerWidth && node.getBoundingClientRect().left >= 0), true); await page.screenshot({ path: join(output, `dialog-${locale}.png`), fullPage: true }); for (let index = 0; index < 15; index++) { await page.keyboard.press('Tab'); assert.equal(await dialog.evaluate(node => node.contains(document.activeElement) || document.activeElement === document.body), true, `Outside interactive focus in ${locale}`); } await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1100, height: 800 });
 }
 checks.push('four locales, narrow viewport, native keyboard focus containment');
 assert.equal(hash(await readFile(audioPath)), beforeAudio); assert.deepEqual(providerRequests.filter(request => request.method !== 'GET' || /generate|chat|pull|transcribe|finalize/.test(request.path)), []); assert.deepEqual(denied, []); assert.deepEqual(pageErrors, []);
 await writeFile(join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, browser: await browser.version(), platform: process.platform, architecture: process.arch, artifacts, checks, deniedRequests: denied.length, providerMutationRequests: 0, audioUnchanged: true, pageErrors }, null, 2));
 console.log(JSON.stringify({ artifacts: artifacts.length, checks, deniedRequests: denied.length }));
} finally {
 await browser?.close(); if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await exited; clearTimeout(timer); } await new Promise(resolve => mock.close(resolve)); log.end(); await rm(temporary, { recursive: true, force: true });
 // Prove the owned server no longer listens; preserve all unrelated services.
 const probe = createSocket(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(apiPort, '127.0.0.1', resolve); }); await new Promise(resolve => probe.close(resolve));
}
