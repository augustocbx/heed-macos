import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReleaseInfo } from './release-info';

const root = () => mkdtempSync(join(tmpdir(), 'heed-release-info-'));

test('a release payload reports its tagged version and commit', () => {
 const dir = root();
 writeFileSync(join(dir, 'VERSION'), '0.1.0\n');
 writeFileSync(join(dir, 'release.json'), JSON.stringify({ version: '0.2.0', tag: 'v0.2.0', commit: 'abc123' }));
 expect(readReleaseInfo(dir)).toEqual({ app: 'heed', component: 'api', version: '0.2.0', tag: 'v0.2.0', commit: 'abc123', channel: 'release' });
});
test('a checkout reports VERSION as a development build', () => {
 const dir = root();
 writeFileSync(join(dir, 'VERSION'), '0.3.1\n');
 expect(readReleaseInfo(dir)).toEqual({ app: 'heed', component: 'api', version: '0.3.1', tag: null, commit: null, channel: 'development' });
});
test('invalid metadata never invents a version', () => {
 const dir = root();
 writeFileSync(join(dir, 'release.json'), '{"version":"latest"}');
 writeFileSync(join(dir, 'VERSION'), 'main\n');
 expect(readReleaseInfo(dir).version).toBe('0.0.0');
 expect(readReleaseInfo(dir).channel).toBe('development');
});
