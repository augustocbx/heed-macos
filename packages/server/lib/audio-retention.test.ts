import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {enforceAudioRetention} from './audio-retention.ts';

test('removes oldest audio and derivatives, preserving transcripts and newer audio', () => {
 const root=mkdtempSync(join(tmpdir(),'heed-retention-')); const sessions=join(root,'sessions'); mkdirSync(sessions);
 try {
  for(const [name,size] of [['dual-capture-100.wav',40],['dual-capture-100-mic.wav',20],['dual-capture-200.wav',60]] as const) {
   writeFileSync(join(root,name),Buffer.alloc(size)); utimesSync(join(root,name),1,name.includes('100')?1:2);
  }
  writeFileSync(join(root,'dual-capture-100.wav.srt'),'transcript');
  writeFileSync(join(sessions,'s.json'),JSON.stringify({transcript:'keep me',files:{wav:join(root,'dual-capture-100.wav'),srt:'keep.srt'}}));
  const result=enforceAudioRetention(root,sessions,100);
  expect(result.bytes).toBe(60); expect(existsSync(join(root,'dual-capture-100-mic.wav'))).toBe(false);
  expect(existsSync(join(root,'dual-capture-200.wav'))).toBe(true);
  expect(existsSync(join(root,'dual-capture-100.wav.srt'))).toBe(true);
  const session=JSON.parse(readFileSync(join(sessions,'s.json'),'utf8'));
  expect(session.transcript).toBe('keep me'); expect(session.files.wav).toBe(''); expect(session.audioExpired).toBe(true);
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('protects active recording and its derivatives, and reports pressure', () => {
 const root=mkdtempSync(join(tmpdir(),'heed-retention-')); const sessions=join(root,'sessions');mkdirSync(sessions);
 try {
  writeFileSync(join(root,'dual-capture-100.wav'),Buffer.alloc(120));
  writeFileSync(join(root,'dual-capture-100-sys.wav'),Buffer.alloc(60));
  const result=enforceAudioRetention(root,sessions,100,[join(root,'dual-capture-100.wav')]);
  expect(result.bytes).toBe(180);expect(result.overLimit).toBe(true);
  expect(existsSync(join(root,'dual-capture-100-sys.wav'))).toBe(true);
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('does not follow symlinks or delete non-audio files', () => {
 const root=mkdtempSync(join(tmpdir(),'heed-retention-')); const sessions=join(root,'sessions');mkdirSync(sessions);
 try {writeFileSync(join(root,'notes.txt'),'keep');expect(enforceAudioRetention(root,sessions,0).bytes).toBe(0);expect(existsSync(join(root,'notes.txt'))).toBe(true);}
 finally {rmSync(root,{recursive:true,force:true});}
});
