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
});
