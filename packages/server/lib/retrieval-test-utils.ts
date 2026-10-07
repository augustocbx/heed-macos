import {expect} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionTags} from './session-tags';
import {RetrievalCatalog,type RetrievalScope} from './retrieval-catalog';
import {RetrievalIndex} from './retrieval-index';
import {createRetrievalPolicy} from './retrieval-policy';
import {ManagedQuota} from './managed-quota';
const module=await import('./meeting-retrieval').catch(()=>null);
const fixtures:Array<{root:string;close:()=>void}>=[];
export function closeRetrievalFixtures(){for(const f of fixtures.splice(0)){f.close();rmSync(f.root,{recursive:true,force:true});}}
export async function retrievalFixture(overrides:any={}){
 expect(module).not.toBeNull();const root=mkdtempSync(join(tmpdir(),'heed-scoped-retrieval-')),directory=join(root,'indexes'),sessions=join(root,'sessions');mkdirSync(sessions);mkdirSync(directory);
 const policy=createRetrievalPolicy(overrides),store=new SessionTags(sessions);let clock=0,busy=false;
 const now=()=>clock,catalog=new RetrievalCatalog({store,policy,now,isBusy:()=>busy}),quota=new ManagedQuota({ledgerPath:join(root,'quota.json'),roots:{text:[sessions],indexes:[directory]},getLimit:()=>1_000_000_000,setLimit:()=>{},protectedPaths:()=>[]});
 const index=new RetrievalIndex({directory,catalog,store,policy,quota,now,isBusy:()=>busy}),retriever=new module!.MeetingRetriever({catalog,index,store,policy,now});
 const f={root,directory,store,catalog,index,retriever,policy,quota,now,time:(value:number)=>{clock=value;},busy:(value:boolean)=>{busy=value;},
  add:(id:string,text:string,tags:string[]=[])=>store.commitSource(id,null,()=>({id,title:id,createdAt:'2026-10-07',duration:1,language:'en',transcript:text,segments:[],speakers:[],tags,aiNotes:'',summary:'',pinned:false,transcriptFinalized:true})),
  snapshot:(scope:RetrievalScope={kind:'library',scope:{mode:'all',labels:[],match:'any'}})=>catalog.resolve(scope).snapshot,
  close:()=>{retriever.close();index.close();catalog.close();}};
 fixtures.push(f);await catalog.reconcile();return f;
}
