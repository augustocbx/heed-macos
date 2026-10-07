import {render, screen, fireEvent, waitFor} from '@testing-library/react';
import {createRef} from 'react';
import {describe, it, expect, vi} from 'vitest';
import {SessionAudioPlayer} from './SessionAudioPlayer.tsx';

describe('meeting audio player',()=>{
 it('uses session audio and tracks playback and seeking',()=>{
  const ref=createRef<HTMLAudioElement>();const onTime=vi.fn();const onDuration=vi.fn();
  render(<SessionAudioPlayer sessionId="session-123" available audioRef={ref} onTime={onTime} onDuration={onDuration}/>);
  const audio=screen.getByLabelText('Meeting audio') as HTMLAudioElement;
  expect(audio.src).toContain('/api/sessions/session-123/audio');
  Object.defineProperty(audio,'currentTime',{value:8.5,writable:true});fireEvent.timeUpdate(audio);
  expect(onTime).toHaveBeenLastCalledWith(8.5);
  audio.currentTime=20;fireEvent.seeked(audio);expect(onTime).toHaveBeenLastCalledWith(20);
  Object.defineProperty(audio,'duration',{value:30});fireEvent.loadedMetadata(audio);
  expect(onDuration).toHaveBeenLastCalledWith(30);
 });
 it('reports removed audio and loading failures without hiding the transcript',()=>{
  const ref=createRef<HTMLAudioElement>();const onTime=vi.fn();const onDuration=vi.fn();
  const view=render(<SessionAudioPlayer sessionId="session-123" available={false} audioRef={ref} onTime={onTime} onDuration={onDuration}/>);
  expect(screen.queryByLabelText('Meeting audio')).toBeNull();
  expect(screen.getByText(/Audio is unavailable/)).toBeInTheDocument();
  view.rerender(<SessionAudioPlayer sessionId="session-123" available audioRef={ref} onTime={onTime} onDuration={onDuration}/>);
  fireEvent.error(screen.getByLabelText('Meeting audio'));
  expect(screen.getByRole('status')).toHaveTextContent('Could not load');
 });
 it('mixes microphone and system audio into mono for both headphone channels',()=>{
  const source={connect:vi.fn()};const mix={channelCount:2,channelCountMode:'max',channelInterpretation:'speakers',connect:vi.fn()};
  const resume=vi.fn().mockResolvedValue(undefined);const createSource=vi.fn(()=>source);
  class MockAudioContext {
   destination={};state='suspended';createMediaElementSource=createSource;
   createGain=vi.fn(()=>mix);resume=resume;close=vi.fn().mockResolvedValue(undefined);
  }
  vi.stubGlobal('AudioContext',MockAudioContext);
  try {
   const ref=createRef<HTMLAudioElement>();
   render(<SessionAudioPlayer sessionId="session-123" available audioRef={ref} onTime={vi.fn()} onDuration={vi.fn()}/>);
   const audio=screen.getByLabelText('Meeting audio');fireEvent.play(audio);
   expect(mix.channelCount).toBe(1);expect(mix.channelCountMode).toBe('explicit');
   expect(source.connect).toHaveBeenCalledWith(mix);expect(mix.connect).toHaveBeenCalled();
   expect(resume).toHaveBeenCalled();fireEvent.play(audio);expect(createSource).toHaveBeenCalledTimes(1);
  } finally {vi.unstubAllGlobals();}
 });
});

it('downloads archived audio only after explicit request and displays quota failure',async()=>{
 const {libraryApi}=await import('@/api/library');vi.mocked(libraryApi.audio).mockRejectedValueOnce(new Error('Managed meeting quota has insufficient available space')).mockResolvedValueOnce({available:true});
 const audioRef={current:null};render(<SessionAudioPlayer sessionId="imported-fixture" available={false} archived audioRef={audioRef} onTime={()=>{}} onDuration={()=>{}}/>);
 expect(libraryApi.audio).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Download archived audio'}));expect(await screen.findByRole('alert')).toHaveTextContent('Increase the storage limit');fireEvent.click(screen.getByRole('button',{name:'Download archived audio'}));await waitFor(()=>expect(screen.getByLabelText('Meeting audio')).toBeInTheDocument());expect(libraryApi.audio).toHaveBeenCalledWith('imported-fixture');
});
vi.mock('@/api/library',()=>({libraryApi:{audio:vi.fn()}}));
it('transcript-only pending cleanup prevents playback and archived downloads even when a WAV remains',()=>{render(<SessionAudioPlayer sessionId="transcript-only" available archived unavailableReason="transcript-only" cleanupPending audioRef={createRef()} onTime={()=>{}} onDuration={()=>{}}/>);expect(screen.queryByLabelText('Meeting audio')).toBeNull();expect(screen.queryByRole('button',{name:'Download archived audio'})).toBeNull();expect(screen.getByText(/Playback and retranscription are unavailable/)).toBeInTheDocument();expect(screen.getByRole('status')).toHaveTextContent('cleanup is pending');});
