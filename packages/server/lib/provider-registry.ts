import {readPrivateJson} from './connectors/private-json';
import {existsSync} from 'node:fs';
import {atomicWriteJson} from './atomic-json';
import type {LibraryProvider} from './portable-provider';
interface Library {snapshot():{providerId?:string};isBusy():boolean;isMutationOwner():boolean;withMutation<T>(run:()=>Promise<T>,signal?:AbortSignal):Promise<T>;selectProvider(provider?:LibraryProvider):void}
interface Options {path:string;getLibrary:()=>Library;write?:typeof atomicWriteJson}
interface Preference {version:1;preferredId:string|null}
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
/** Device-only selection; portable meeting identities never depend on a connector preference. */
export class ProviderRegistry {
 private factories=new Map<string,()=>LibraryProvider>();private error:string|null=null;private preference:Preference={version:1,preferredId:null};
 constructor(private options:Options){try{if(existsSync(options.path)){const value=readPrivateJson<Preference>(options.path,16384);if(!value||Object.keys(value).sort().join(',')!=='preferredId,version'||value.version!==1||value.preferredId!==null&&!validId(value.preferredId))throw new Error('Invalid provider preference; preserve it for recovery.');this.preference=value;}}catch{this.error='Invalid provider preference; preserve it for recovery.';}}
 unavailable(){return this.error!==null;}
 assertAvailable(){if(this.error)throw new Error(this.error);}
 withMutation<T>(run:()=>Promise<T>,signal?:AbortSignal):Promise<T>{this.assertAvailable();return this.options.getLibrary().withMutation(run,signal);}
 preferredId(){return this.preference.preferredId;}
 currentId(){return this.options.getLibrary().snapshot().providerId;}
 assertIdle(){this.assertAvailable();const library=this.options.getLibrary();if(library.isBusy()&&!library.isMutationOwner())throw new Error('A library operation is already running. Wait before changing synchronization destinations.');}
 register(id:string,factory:()=>LibraryProvider){if(!validId(id))throw new Error('Invalid provider identity.');const previous=this.factories.get(id);if(previous&&previous!==factory)throw new Error('Provider identity is already registered.');this.factories.set(id,factory);}
 private provider(id:string){const factory=this.factories.get(id);if(!factory)throw new Error('Synchronization destination is unavailable.');const provider=factory();if(provider.id!==id)throw new Error('Provider identity changed.');return provider;}
 private persist(id:string|null){const next:Preference={version:1,preferredId:id};(this.options.write||atomicWriteJson)(this.options.path,next);this.preference=next;}
 activate(id:string){this.assertIdle();const provider=this.provider(id);this.persist(id);this.options.getLibrary().selectProvider(provider);}
 deactivate(id:string){this.assertIdle();if(this.preference.preferredId===id)this.persist(null);if(this.currentId()===id)this.options.getLibrary().selectProvider();}
 unregister(id:string){this.deactivate(id);this.factories.delete(id);}
 /** Call after startup registrations; unavailable accounts retain their preference for reconnect. */
 restore(){this.assertAvailable();const id=this.preference.preferredId;if(id&&this.factories.has(id)){this.assertIdle();this.options.getLibrary().selectProvider(this.provider(id));}}
}
