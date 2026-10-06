import type {PortableCommit,PortableManifest,PortableMeeting,Session} from '../../../shared/types';
import {encode,makeBundle,portableMeeting,sha256,validateBundle,validateCommit,validateManifest,validateMeeting} from '../portable-schema';

export interface PortableRevisionEvidence {manifest:PortableManifest;payload:PortableMeeting;marker?:PortableCommit;audioSha256?:string}

/** Public corrected meeting data, never derived from an installed user's sessions. */
export function publicSynchronizationFixture(locale:'en'|'pt'){
 const text=locale==='en'
  ? ['Cobalt launch was approved for Tuesday. Ana owns the checklist.','The lunar relay proposal was rejected.','Correction: the approved budget is 43 credits, replacing the earlier 42 credits.']
  : ['O Lançamento Cobalto foi aprovado para terça-feira. Ana é responsável pela lista.','A proposta de retransmissão lunar foi rejeitada.','Correção: o orçamento aprovado é de 43 créditos, substituindo os 42 créditos anteriores.'];
 const audio=Buffer.alloc(44+16000*4*3);
 audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);
 audio.writeUInt16LE(1,20);audio.writeUInt16LE(2,22);audio.writeUInt32LE(16000,24);audio.writeUInt32LE(64000,28);audio.writeUInt16LE(4,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(audio.length-44,40);
 for(let frame=0;frame<48000;frame++){audio.writeInt16LE(Math.round(5000*Math.sin(2*Math.PI*440*frame/16000)),44+frame*4);audio.writeInt16LE(Math.round(4000*Math.sin(2*Math.PI*660*frame/16000)),46+frame*4);}
 const audioSha256=sha256(audio);
 const session:Session={id:'public-synchronization-fixture',title:locale==='en'?'Cobalt planning QA':'Planejamento Cobalto QA',createdAt:'2026-10-06T12:00:00.000Z',updatedAt:'2026-10-06T12:03:00.000Z',duration:3,language:locale,transcript:text.join('\n'),segments:text.map((text,index)=>({speaker:index===1?'Bruno QA':'Ana QA',text,start:index,end:index+1,channel:index===1?'sys':'mic'})),speakers:['Ana QA','Bruno QA'],tags:['Synchronization QA',locale==='en'?'Planning':'Planejamento'],aiNotes:locale==='en'?'## Decision\nTuesday launch; Ana owns the checklist. Corrected budget: 43 credits.':'## Decisão\nLançamento na terça-feira; Ana cuida da lista. Orçamento corrigido: 43 créditos.',summary:locale==='en'?'Approved Cobalt launch; lunar relay rejected.':'Lançamento Cobalto aprovado; retransmissão lunar rejeitada.',pinned:true,transcriptFinalized:true,transcriptionModel:'public-qa-final',liveModel:'public-qa-live'};
 const payload=portableMeeting(session,locale==='en'?'1c36c9f7-452b-4a17-a057-c0222251eafe':'7b7b2153-77e1-4cb0-a528-fc7e1abf4ca5',{sha256:audioSha256,bytes:audio.length,format:'wav',mode:'archived',objectPath:`objects/${audioSha256}`});
 const bundle=makeBundle('135c57b9-bebf-41cd-a89c-2a0b9b06f7ee','4f6f980e-b752-4a4d-9955-b386f2146636',payload,[],locale==='en'?'fe92d76c-fd82-460f-b01f-61b62d5b170a':'89a7b69c-dc3e-489d-a490-2855b9bd8689');
 return {...bundle,audio,audioSha256,session};
}

function canonical(value:unknown):string{
 if(value===undefined)return 'undefined';
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 if(value!==null&&typeof value==='object')return `{${Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
 return JSON.stringify(value);
}

/** Return field names only: evidence reports must never echo meeting content. */
export function comparePortableRevision(expected:PortableRevisionEvidence,actual:PortableRevisionEvidence):string[]{
 const differences=new Set<string>();
 const fields={manifest:['schemaVersion','libraryId','meetingId','revisionId','parents','artifacts'],payload:['schemaVersion','meetingId','title','createdAt','updatedAt','duration','language','transcript','segments','speakers','tags','aiNotes','summary','pinned','transcriptFinalized','transcriptionModel','liveModel','audio'],marker:['schemaVersion','libraryId','meetingId','revisionId','deviceId','manifestPath','manifestHash']};
 const compare=(kind:'manifest'|'payload'|'marker',left:object,right:object)=>{
  for(const key of fields[kind]){
   if(canonical((left as Record<string,unknown>)[key])!==canonical((right as Record<string,unknown>)[key]))differences.add(`${kind}.${key}`);
  }
 };
 validateManifest(expected.manifest);validateMeeting(expected.payload);
 if(expected.marker)validateBundle(expected.marker,expected.manifest,encode(expected.payload));
 let manifestValid=true,payloadValid=true;
 try{validateManifest(actual.manifest);}catch{manifestValid=false;differences.add('manifest.invalid');}
 try{validateMeeting(actual.payload);}catch{payloadValid=false;differences.add('payload.invalid');}
 if(actual.manifest&&typeof actual.manifest==='object')compare('manifest',expected.manifest,actual.manifest);
 if(actual.payload&&typeof actual.payload==='object')compare('payload',expected.payload,actual.payload);
 if(expected.marker){
  if(!actual.marker)differences.add('marker.missing');
  else{
   try{validateCommit(actual.marker);}catch{differences.add('marker.invalid');}
   compare('marker',expected.marker,actual.marker);
  }
 }
 if(manifestValid&&payloadValid){
  const artifact=actual.manifest.artifacts[0]!,bytes=encode(actual.payload);
  if(artifact.bytes!==bytes.length||artifact.sha256!==sha256(bytes)||actual.payload.meetingId!==actual.manifest.meetingId)differences.add('bundle.integrity');
  if(actual.marker){try{validateBundle(actual.marker,actual.manifest,bytes);}catch{differences.add('bundle.integrity');}}
 }
 if(actual.audioSha256!==undefined&&actual.audioSha256!==expected.payload.audio?.sha256)differences.add('audio.sha256');
 return [...differences].sort();
}
