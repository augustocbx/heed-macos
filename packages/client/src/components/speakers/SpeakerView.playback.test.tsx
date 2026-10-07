import {render, screen, fireEvent} from '@testing-library/react';
import {describe,it,test,expect,vi} from 'vitest';
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
 it('disables speaker rename and merge while the final save is committing',()=>{
  const prompt=vi.spyOn(window,'prompt');
  render(<SpeakerView {...props} editingDisabled={true}/>);
  const chip=screen.getAllByTitle('Click to rename · Right-click to merge')[0];
  fireEvent.click(chip);fireEvent.contextMenu(chip);
  expect(prompt).not.toHaveBeenCalled();
  expect(screen.queryByText('Merge "A" into:')).not.toBeInTheDocument();
  prompt.mockRestore();
 });
});

it('citation focus highlights text evidence even when audio has expired',()=>{
 render(<SpeakerView {...props} focusedSegmentIndex={2}/>);
 expect(screen.getByText('Last segment')).toHaveAttribute('aria-current','true');
 expect(screen.getByText('First segment')).not.toHaveAttribute('aria-current','true');
});
test('saved edit controls are siblings of seek controls and never seek; live views omit them',()=>{
 const seek=vi.fn(),edit=vi.fn(),segments=[{speaker:'Ana',start:1,end:2,text:''}];
 const view=render(<SpeakerView segments={segments} speakers={['Ana']} speakerNames={{}} onRename={vi.fn()} onMerge={vi.fn()} onSeek={seek} onEditText={edit} animateEmpty={false}/>);
 fireEvent.click(screen.getByRole('button',{name:'Edit segment 1'}));expect(edit).toHaveBeenCalledWith(0);expect(seek).not.toHaveBeenCalled();expect(screen.getByText('Empty transcript text')).toBeVisible();
 fireEvent.keyDown(screen.getByRole('button',{name:'Empty transcript text'}),{key:'Enter'});expect(seek).toHaveBeenCalledWith(1);
 view.rerender(<SpeakerView segments={segments} speakers={['Ana']} speakerNames={{}} onRename={vi.fn()} onMerge={vi.fn()} animateEmpty={false}/>);expect(screen.queryByRole('button',{name:'Edit segment 1'})).not.toBeInTheDocument();
});
