import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const module = await import('./processing-maintenance').catch(() => null);
const directories: string[] = [];
const transaction = '11111111-1111-4111-8111-111111111111';
function create(active: () => string[] = () => [], write?: (path: string, value: unknown) => void) {
 expect(module, 'Processing maintenance has not been implemented').not.toBeNull();
 const directory = mkdtempSync(join(tmpdir(), 'heed-maintenance-')); directories.push(directory);
 const path = join(directory, 'lease.json');
 return {path, gate: new module!.ProcessingMaintenance({path, active, ...(write ? {write} : {})})};
}
afterEach(() => {for (const directory of directories.splice(0)) rmSync(directory, {recursive:true, force:true});});

for (const kind of ['recording', 'saving', 'transcription', 'notes', 'tasks', 'chat', 'libraryChat', 'synchronization', 'authorization']) {
 test(`active ${kind} prevents update acquisition and permits explicit retry when finished`, () => {
  let jobs = [kind]; const {gate} = create(() => jobs);
  expect(() => gate.acquire('updater', transaction)).toThrow('active');
  expect(gate.blocked()).toBe(false);
  jobs = []; gate.acquire('updater', transaction);
  expect(gate.blocked()).toBe(true);
 });
}
test('admitted operations prevent replacement and no new operation enters maintenance', () => {
 const {gate} = create(); const release = gate.enter('mediaImport');
 expect(() => gate.acquire('updater', transaction)).toThrow('active');
 release(); release(); gate.acquire('updater', transaction);
 expect(() => gate.enter('migration')).toThrow('maintenance');
 gate.release('updater'); expect(gate.enter('migration')).toBeFunction();
});
test('update owner persists through restart and another owner cannot release or replace it', () => {
 const {gate, path} = create(); gate.acquire('updater', transaction);
 const restarted = new module!.ProcessingMaintenance({path, active:() => []});
 expect(restarted.blocked()).toBe(true);
 expect(restarted.owner()).toBe('updater');
 expect(restarted.transactionId()).toBe(transaction);
 expect(() => restarted.release('other')).toThrow('owner');
 expect(() => restarted.acquire('updater', '22222222-2222-4222-8222-222222222222')).toThrow('transaction');
 restarted.release('updater');
 expect(new module!.ProcessingMaintenance({path, active:() => []}).blocked()).toBe(false);
});
test('ordinary maintenance does not survive a backend restart', () => {
 const {gate, path} = create(); gate.acquire('manual-installer');
 expect(gate.blocked()).toBe(true);
 expect(new module!.ProcessingMaintenance({path, active:() => []}).blocked()).toBe(false);
});
test('failed lease persistence does not leave an acquired in-memory owner', () => {
 const {gate} = create(() => [], () => {throw Error('storage unavailable');});
 expect(() => gate.acquire('updater', transaction)).toThrow('storage unavailable');
 expect(gate.blocked()).toBe(false);
});
test('malformed and symlinked lease records fail closed and preserve their contents', () => {
 const {path} = create(); writeFileSync(path, 'not JSON');
 let gate = new module!.ProcessingMaintenance({path, active:() => []});
 expect(gate.blocked()).toBe(true);
 expect(() => gate.release('any')).toThrow('recovery');
 expect(readFileSync(path, 'utf8')).toBe('not JSON');
 rmSync(path); const target = path + '.private'; writeFileSync(target, '{}'); symlinkSync(target, path);
 gate = new module!.ProcessingMaintenance({path, active:() => []});
 expect(gate.blocked()).toBe(true);
 expect(() => gate.enter('mediaImport')).toThrow('maintenance');
});
