import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Session } from '@heed/shared';
import { ResultCard } from './ResultCard';
import { useRecordingStore } from '@/stores/recording';
import { useSessionsStore } from '@/stores/sessions';
import { useTemplatesStore } from '@/stores/templates';
import { useModelsStore } from '@/stores/models';
import { setLocale } from '@/lib/i18n';
const session = { id: 's', title: 'Meeting', transcriptRevision: 'r', language: 'pt', transcript: 'Bom dia', aiNotes: '', speakers: ['Ana'], segments: [{ speaker: 'Ana', text: 'Bom dia', start: 0, end: 1 }], tags: [] } as unknown as Session;
beforeEach(() => {
 setLocale('en'); useRecordingStore.getState().reset(); useRecordingStore.setState({ currentSessionId: 's', transcript: 'English preview', resultLanguage: 'en' });
 useSessionsStore.setState({ sessions: [session], viewing: null });
 useTemplatesStore.setState({ load: vi.fn(), templates: [{ id: 'general', name: 'General', description: '', prompt: '' }] });
 useModelsStore.setState({ load: vi.fn(), data: null });
});
afterEach(() => vi.unstubAllGlobals());
test('manual notes use saved meeting language and speaker labels with compare-and-save', async () => {
 const requests: Array<{ url: string; init?: RequestInit }> = [];
 vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  requests.push({ url, init });
  if (url === '/api/summarize') return new Response('data: {"token":"Saved notes"}\n\ndata: {"done":true}\n\n');
  if (init?.method === 'PATCH') return Response.json({ ...session, aiNotes: 'Saved notes' });
  return Response.json([{ ...session, aiNotes: 'Saved notes' }]);
 }));
 render(<ResultCard />); fireEvent.click(screen.getByText('AI Notes'));
 fireEvent.click(screen.getByRole('button', { name: /Generate AI notes/ }));
 await waitFor(() => expect(useRecordingStore.getState().notesText).toBe('Saved notes'));
 const generate = requests.find(request => request.url === '/api/summarize')!;
 expect(JSON.parse(String(generate.init!.body))).toMatchObject({ language: 'pt', transcript: 'Ana: Bom dia' });
 const persist = requests.find(request => request.init?.method === 'PATCH')!;
 expect(JSON.parse(String(persist.init!.body))).toEqual({ aiNotes: 'Saved notes', expectedNotes: '', expectedTranscriptRevision: 'r', expectedTranscriptVersion: 0 });
});
test('result notes update from automatic saved-session changes', () => {
 render(<ResultCard />); fireEvent.click(screen.getByText('AI Notes'));
 act(() => useSessionsStore.getState().accept({ ...session, aiNotes: 'Automatic saved result' }));
 expect(screen.getByText('Automatic saved result')).toBeInTheDocument();
});
test('manual generation is disabled while automatic generation is pending', () => {
 useSessionsStore.setState({ sessions: [{ ...session, notesJobs: { 'notes-r': { sourceRevision: 'r', status: 'running' } } } as unknown as Session] });
 render(<ResultCard />); fireEvent.click(screen.getByText('AI Notes'));
 expect(screen.getByRole('button', { name: /Generate AI notes/ })).toBeDisabled();
});

test('a notes conflict keeps the completed result draft without changing accepted notes',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>url==='/api/summarize'?new Response('data: {"token":"Retained draft"}\n\ndata: {"done":true}\n\n'):Response.json({error:'Transcript changed'},{status:409})));
 render(<ResultCard/>);fireEvent.click(screen.getByText('AI Notes'));fireEvent.click(screen.getByRole('button',{name:/Generate AI notes/}));
 await waitFor(()=>expect(screen.getByText('Retained draft')).toBeVisible());
 await waitFor(()=>expect(screen.getByRole('button',{name:/Generate AI notes/})).toBeEnabled());
 expect(useSessionsStore.getState().sessions[0].aiNotes).toBe('');expect(useRecordingStore.getState().notesText).toBe('');
});

test.each([true,false])('all-empty accepted source disables derived notes on GPU/CPU (%s)',fitsGpu=>{
 const empty={...session,transcript:'\n',segments:[{speaker:'Ana',text:'',start:0,end:1},{speaker:'Ana',text:'',start:1,end:2}]};useSessionsStore.setState({sessions:[empty]});if(!fitsGpu)useModelsStore.setState({data:{current:{id:'model'},models:[{id:'model',gpu_runtime_ok:false}]} as any});vi.stubGlobal('fetch',vi.fn());render(<ResultCard/>);fireEvent.click(screen.getByText('AI Notes'));expect(screen.getByRole('button',{name:fitsGpu?/Generate AI notes/:/Generate on CPU/})).toBeDisabled();expect(screen.getByText('This transcript has no usable text. Add a correction before generating notes.')).toBeVisible();expect(fetch).not.toHaveBeenCalled();
});

test('result view can review durable drafts without saved audio or another recognition call',()=>{
 const base={expectedTranscriptRevision:'r',expectedTranscriptVersion:0};useSessionsStore.setState({sessions:[{...session,transcriptEditing:{schemaVersion:1,activeGenerationId:'g',generations:[],edits:[],candidateRequestReceipts:[],candidates:[{id:'draft',createdAt:'2026-10-06',requestId:'stage',requestSignature:'sig',baseGuard:base,transcript:'Pending draft',segments:[],speakers:[],language:'pt',duration:1}]}}]});vi.stubGlobal('fetch',vi.fn());render(<ResultCard/>);fireEvent.click(screen.getByRole('button',{name:'Review new transcript'}));expect(screen.getByText('Pending draft')).toBeVisible();expect(screen.getByRole('button',{name:'Start transcription'})).toBeDisabled();expect(fetch).not.toHaveBeenCalled();
});

vi.mock('@/components/recording/VocabularySelection',()=>({VocabularySelection:()=>null}));
