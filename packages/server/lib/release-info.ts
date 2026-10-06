import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Identity returned by /api/version; installers and update checks use it to tell Heed from other local apps. */
export interface ReleaseInfo { app: 'heed'; component: 'api'; version: string; tag: string | null; commit: string | null; channel: 'release' | 'development' }

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Release payloads carry release.json; a Git checkout only has VERSION and reports a development build. */
export function readReleaseInfo(root: string): ReleaseInfo {
 const release = join(root, 'release.json');
 if (existsSync(release)) {
  try {
   const data = JSON.parse(readFileSync(release, 'utf8'));
   if (typeof data.version === 'string' && SEMVER.test(data.version)) {
    return { app: 'heed', component: 'api', version: data.version, tag: typeof data.tag === 'string' ? data.tag : `v${data.version}`,
     commit: typeof data.commit === 'string' ? data.commit : null, channel: 'release' };
   }
  } catch {}
 }
 let version = '0.0.0';
 try { const value = readFileSync(join(root, 'VERSION'), 'utf8').trim(); if (SEMVER.test(value)) version = value; } catch {}
 return { app: 'heed', component: 'api', version, tag: null, commit: null, channel: 'development' };
}
