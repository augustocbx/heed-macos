import {render, screen, fireEvent} from '@testing-library/react';
import {createRef} from 'react';
import {describe, it, expect, vi} from 'vitest';
import {SessionAudioPlayer} from './SessionAudioPlayer.tsx';

describe('player de reunião',()=>{
 it('usa o áudio da sessão e acompanha reprodução e avanço manual',()=>{
  const ref=createRef<HTMLAudioElement>();const onTime=vi.fn();const onDuration=vi.fn();
  render(<SessionAudioPlayer sessionId="session-123" available audioRef={ref} onTime={onTime} onDuration={onDuration}/>);
  const audio=screen.getByLabelText('Áudio da reunião') as HTMLAudioElement;
  expect(audio.src).toContain('/api/sessions/session-123/audio');
  Object.defineProperty(audio,'currentTime',{value:8.5,writable:true});fireEvent.timeUpdate(audio);
  expect(onTime).toHaveBeenLastCalledWith(8.5);
  audio.currentTime=20;fireEvent.seeked(audio);expect(onTime).toHaveBeenLastCalledWith(20);
  Object.defineProperty(audio,'duration',{value:30});fireEvent.loadedMetadata(audio);
  expect(onDuration).toHaveBeenLastCalledWith(30);
 });
 it('informa áudio removido e falha de carregamento sem esconder a transcrição',()=>{
  const ref=createRef<HTMLAudioElement>();const onTime=vi.fn();const onDuration=vi.fn();
  const view=render(<SessionAudioPlayer sessionId="session-123" available={false} audioRef={ref} onTime={onTime} onDuration={onDuration}/>);
  expect(screen.queryByLabelText('Áudio da reunião')).toBeNull();
  expect(screen.getByText(/Áudio indisponível/)).toBeInTheDocument();
  view.rerender(<SessionAudioPlayer sessionId="session-123" available audioRef={ref} onTime={onTime} onDuration={onDuration}/>);
  fireEvent.error(screen.getByLabelText('Áudio da reunião'));
  expect(screen.getByRole('status')).toHaveTextContent('Não foi possível carregar');
 });
 it('mistura microfone e sistema em mono antes de enviar aos dois lados do fone',()=>{
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
   const audio=screen.getByLabelText('Áudio da reunião');fireEvent.play(audio);
   expect(mix.channelCount).toBe(1);expect(mix.channelCountMode).toBe('explicit');
   expect(source.connect).toHaveBeenCalledWith(mix);expect(mix.connect).toHaveBeenCalled();
   expect(resume).toHaveBeenCalled();fireEvent.play(audio);expect(createSource).toHaveBeenCalledTimes(1);
  } finally {vi.unstubAllGlobals();}
 });
});
