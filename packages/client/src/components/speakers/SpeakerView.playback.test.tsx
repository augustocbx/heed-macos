import {render, screen, fireEvent} from '@testing-library/react';
import {describe,it,expect,vi} from 'vitest';
import {SpeakerView} from './SpeakerView.tsx';

const segments=[{speaker:'A',start:1,end:3,text:'Primeiro trecho'},{speaker:'B',start:2,end:4,text:'Fala simultânea'},{speaker:'A',start:5,end:8,text:'Último trecho'}];
const props={segments,speakers:['A','B'],speakerNames:{},onRename:vi.fn(),onMerge:vi.fn(),animateEmpty:false};
describe('transcrição sincronizada',()=>{
 it('destaca todos os trechos simultâneos e remove destaque durante silêncio',()=>{
  const view=render(<SpeakerView {...props} playbackTime={2.5} onSeek={vi.fn()}/>);
  expect(screen.getByRole('button',{name:/Primeiro trecho/})).toHaveAttribute('aria-current','true');
  expect(screen.getByRole('button',{name:/Fala simultânea/})).toHaveAttribute('aria-current','true');
  view.rerender(<SpeakerView {...props} playbackTime={4.5} onSeek={vi.fn()}/>);
  expect(screen.getByRole('button',{name:/Primeiro trecho/})).not.toHaveAttribute('aria-current','true');
  expect(screen.getByText('Último trecho')).toBeInTheDocument();
 });
 it('avança ao trecho com clique ou teclado sem renomear o participante',()=>{
  const seek=vi.fn();render(<SpeakerView {...props} playbackTime={null} onSeek={seek}/>);
  fireEvent.click(screen.getByRole('button',{name:/Último trecho/}));expect(seek).toHaveBeenLastCalledWith(5);
  fireEvent.keyDown(screen.getByRole('button',{name:/Primeiro trecho/}),{key:'Enter'});expect(seek).toHaveBeenLastCalledWith(1);
 });
});
