import {join} from 'node:path';
import {APP_DIR,SESSIONS_DIR,loadConfig,saveConfig} from './app-config';
import {ManagedQuota,configuredManagedLimit,validManagedLimit} from './managed-quota';
import {setAtomicWriteBudget} from './atomic-json';

/** Shared device-local allocation service for recording, persistence and provider jobs. */
export function createAppQuota(options:{recordingsDir:string;protectedPaths:()=>string[];onEvicted:(paths:string[])=>void;disposableFiles?:()=>string[];disposeFiles?:(paths:string[])=>void}):ManagedQuota{
 if(!validManagedLimit(loadConfig().storage_limit_bytes))saveConfig({storage_limit_bytes:configuredManagedLimit(loadConfig().storage_limit_bytes)});
 const quota=new ManagedQuota({
  ledgerPath:join(APP_DIR,'quota-reservations.json'),
  roots:{text:[SESSIONS_DIR,join(APP_DIR,'tasks.json'),join(APP_DIR,'chat'),join(APP_DIR,'library-chat'),join(APP_DIR,'recording-manifest.json'),join(APP_DIR,'recording-recovery'),join(APP_DIR,'library','catalog')],media:[options.recordingsDir,join(APP_DIR,'library','media')],indexes:[join(APP_DIR,'library','indexes')],staging:[join(APP_DIR,'library','staging')]},
  getLimit:()=>configuredManagedLimit(loadConfig().storage_limit_bytes),setLimit:bytes=>saveConfig({storage_limit_bytes:bytes}),
  protectedPaths:options.protectedPaths,onEvicted:options.onEvicted,disposableFiles:options.disposableFiles,disposeFiles:options.disposeFiles,
 });
 setAtomicWriteBudget((path,bytes,temporary)=>quota.atomicWriteBudget(path,bytes,temporary));return quota;
}
