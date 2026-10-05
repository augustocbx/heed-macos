import {render, screen, fireEvent} from '@testing-library/react';
import {describe,it,expect,vi} from 'vitest';
import {SpeakerView} from './SpeakerView.tsx';

const segments=[{speaker:'A',start:1,end:3,text:'First segment'},{speaker:'B',start:2,end:4,text:'Simultaneous speech'},{speaker:'A',start:5,end:8,text:'Last segment'}];
const props={segments,speakers:['A','B'],speakerNames:{},onRename:vi.fn(),onMerge:vi.fn(),animateEmpty:false};
describe('synchronized transcript',()=>{
 it('highlights simultaneous segments and clears highlighting during silence',()=>{
  const view=render(<SpeakerView {...props} playbackTime={2.5} onSeek={vi.fn()}/>);
  expect(screen.getByRole('button',{name:/First segment/})).toHaveAttribute('aria-current','true');
  expect(screen.getByRole('button',{name:/Simultaneous speech/})).toHaveAttribute('aria-current','true');
  view.rerender(<SpeakerView {...props} playbackTime={4.5} onSeek={vi.fn()}/>);
  expect(screen.getByRole('button',{name:/First segment/})).not.toHaveAttribute('aria-current','true');
  expect(screen.getByText('Last segment')).toBeInTheDocument();
 });
 it('seeks to a segment by click or keyboard without renaming the speaker',()=>{
  const seek=vi.fn();render(<SpeakerView {...props} playbackTime={null} onSeek={seek}/>);
  fireEvent.click(screen.getByRole('button',{name:/Last segment/}));expect(seek).toHaveBeenLastCalledWith(5);
  fireEvent.keyDown(screen.getByRole('button',{name:/First segment/}),{key:'Enter'});expect(seek).toHaveBeenLastCalledWith(1);
 });
});
