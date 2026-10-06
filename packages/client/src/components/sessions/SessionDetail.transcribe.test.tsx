import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Session } from '@heed/shared';
import { SessionDetail } from './SessionDetail';
import { useSessionsStore } from '@/stores/sessions';
import { useTemplatesStore } from '@/stores/templates';
import { useModelsStore } from '@/stores/models';
import { useRecordingStore } from '@/stores/recording';

const session = {transcriptRevision:'source-before',id:'s1',title:'Meeting',createdAt:'2026-10-05T12:00:00Z',duration:20,language:'en',transcript:'Old text',
 speakers:['Ana'],segments:[{speaker:'Ana',start:0,end:10,text:'Old text',channel:'sys',auto:false}],
 embeddings:{Ana:[1]},files:{wav:'/recordings/meeting.wav'},aiNotes:'Original notes',summary:'Summary',tags:[],pinned:false,liveModel:'base'} as Session;
const diagnostics: NonNullable<Session['transcriptionDiagnostics']> = {version:1,aecApplied:false,channels:{mic:{rawRms:.03,rawPeak:2000,cleanedRms:.03,asrSegments:1,diarizationSegments:0,usableEmbeddings:0,retainedSegments:1,discardedSegments:0,discardReasons:{},fallbackSegments:1,diarizationFailed:true}},warnings:['microphone-attribution-fallback']};
const result = {transcriptionDiagnostics:diagnostics,success:true,text:'Bom dia',files:{wav:'/tmp/new.wav',srt:'',txt:''},metadata:{language:'pt',model:'small'},
 speakers:['Speaker 4'],segments:[{speaker:'Speaker 4',start:0,end:10,text:'Bom dia',channel:'sys'}],embeddings:{'Speaker 4':[2]},wordCount:2};
beforeEach(()=>{
 useSessionsStore.setState({sessions:[session],viewing:session});
 useTemplatesStore.setState({load:vi.fn()});useModelsStore.setState({load:vi.fn()});
 useRecordingStore.setState({recording:false,processing:false});
});
afterEach(()=>vi.unstubAllGlobals());

test('manual transcription sends model and language, saves only final result, and preserves audio and speaker names',async()=>{
 const requests:Array<{url:string;init:RequestInit}>=[];
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{
  requests.push({url,init});
  if(url.includes('/api/transcribe')) return new Response(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
  return new Response(JSON.stringify({...session,...JSON.parse(init.body as string)}));
 }));
 render(<SessionDetail session={session} onBack={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Transcribe'}));
 fireEvent.change(screen.getByLabelText('Transcription model'),{target:{value:'small'}});
 fireEvent.change(screen.getByLabelText('Meeting language'),{target:{value:'pt'}});
 fireEvent.click(screen.getByRole('button',{name:'Start transcription'}));
 await waitFor(()=>expect(useSessionsStore.getState().viewing?.transcript).toBe('Bom dia'));
 const form=requests[0].init.body as FormData;
 expect(form.get('url')).toBe('/recordings/meeting.wav');expect(form.get('final_model')).toBe('small');expect(form.get('language')).toBe('pt');
 expect(form.get('recording_finalize')).toBe('true');
 const saved=useSessionsStore.getState().viewing!;
 expect(saved.speakers).toEqual(['Ana']);expect(saved.embeddings).toEqual({Ana:[2]});expect(saved.files).toEqual(session.files);
 expect(saved.transcriptionDiagnostics).toEqual(diagnostics);expect(saved.duration).toBe(20);expect(saved.language).toBe('pt');expect(saved.liveModel).toBe('base');expect(saved.transcriptionModel).toBe('small');
});

test('failed transcription leaves the existing session intact and displays the error',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('event: error\ndata: {"message":"Model download failed"}\n\n')));
 render(<SessionDetail session={session} onBack={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Transcribe'}));fireEvent.click(screen.getByRole('button',{name:'Start transcription'}));
 await screen.findByRole('alert');expect(screen.getByRole('alert')).toHaveTextContent('Model download failed');
 expect(useSessionsStore.getState().viewing).toEqual(session);expect(useRecordingStore.getState().processing).toBe(false);
});

test('manual transcription is unavailable during recording or without saved audio',()=>{
 useRecordingStore.setState({recording:true});const view=render(<SessionDetail session={session} onBack={vi.fn()}/>);
 expect(screen.getByRole('button',{name:'Transcribe'})).toBeDisabled();view.unmount();
 useRecordingStore.setState({recording:false});render(<SessionDetail session={{...session,files:{}}} onBack={vi.fn()}/>);
 expect(screen.getByRole('button',{name:'Transcribe'})).toBeDisabled();
});


test('manual transcription corrects a stale session timer from the full audio duration',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>url.includes('/api/transcribe')
  ? new Response(`event: result\ndata: ${JSON.stringify({...result,duration:732.5})}\n\n`)
  : new Response(JSON.stringify({...session,...JSON.parse(init.body as string)}))));
 render(<SessionDetail session={session} onBack={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Transcribe'}));fireEvent.click(screen.getByRole('button',{name:'Start transcription'}));
 await waitFor(()=>expect(useSessionsStore.getState().viewing?.duration).toBe(732.5));
});

test('a completed transcript does not replace the session when saving fails',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.includes('/api/transcribe')
  ? new Response(`event: result\ndata: ${JSON.stringify(result)}\n\n`)
  : new Response(JSON.stringify({error:'Could not save transcript'}),{status:500})));
 render(<SessionDetail session={session} onBack={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Transcribe'}));fireEvent.click(screen.getByRole('button',{name:'Start transcription'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Could not save transcript');
 expect(useSessionsStore.getState().viewing).toEqual(session);
});

 test('saved transcription warnings explain uncertain attribution without exposing diagnostics',()=>{
 render(<SessionDetail session={{...session,transcriptionDiagnostics:structuredClone(diagnostics)}} onBack={vi.fn()}/>);
 expect(screen.getByText('Some microphone speech has uncertain speaker labels. Review the transcript and speaker names.')).toBeInTheDocument();
 expect(screen.queryByText('diarizationFailed')).not.toBeInTheDocument();
 });

test('a late retranscription result cannot overwrite newer transcript and manual speaker edits',async()=>{
 const newer={...session,transcript:'Newer manual text',transcriptRevision:'source-after',speakers:['Renamed speaker']};
 let submitted:any;
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{
  if(url.includes('/api/transcribe')){
   useSessionsStore.setState({sessions:[newer],viewing:newer});
   return new Response(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
  }
  submitted=JSON.parse(init.body as string);
  return submitted.expectedTranscriptRevision===session.transcriptRevision
   ? new Response(JSON.stringify({error:'Transcript changed; reload before saving notes'}),{status:409})
   : Response.json({...newer,...submitted});
 }));
 render(<SessionDetail session={session} onBack={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Transcribe'}));fireEvent.click(screen.getByRole('button',{name:'Start transcription'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Transcript changed');
 expect(submitted.expectedTranscriptRevision).toBe('source-before');
 expect(useSessionsStore.getState().viewing).toEqual(newer);
});

test('generated fallback labels do not replace newly available speaker attribution',async()=>{
 const uncertain={...session,speakers:['System (unattributed)'],segments:[{...session.segments[0]!,speaker:'System (unattributed)',attribution:'fallback' as const,auto:false}]};
 useSessionsStore.setState({sessions:[uncertain],viewing:uncertain});
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>url.includes('/api/transcribe')
  ? new Response(`event: result\ndata: ${JSON.stringify(result)}\n\n`)
  : Response.json({...uncertain,...JSON.parse(init.body as string)})));
 render(<SessionDetail session={uncertain} onBack={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Transcribe'}));fireEvent.click(screen.getByRole('button',{name:'Start transcription'}));
 await waitFor(()=>expect(useSessionsStore.getState().viewing?.transcript).toBe('Bom dia'));
 expect(useSessionsStore.getState().viewing?.speakers).toEqual(['Speaker 4']);
});
