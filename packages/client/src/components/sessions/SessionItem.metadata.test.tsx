import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { Session } from '@heed/shared';
import { SessionItem } from './SessionItem';
const session={id:'s',title:'Meeting',createdAt:'2026-10-05T12:00:00Z',duration:3,language:'pt',speakers:[],tags:[],transcript:'',segments:[],aiNotes:'',summary:'',pinned:false} as Session;
const props={onOpen:vi.fn(),onMenu:vi.fn(),onTagClick:vi.fn(),onDelete:vi.fn()};
test('session cards display detected language and recorded model metadata',()=>{
 render(<SessionItem {...props} session={{...session,liveModel:'base',transcriptionModel:'parakeet-v3'}}/>);
 expect(screen.getByText(/Portuguese \(Brazil\)/)).toHaveTextContent('Live: Whisper base · Final: Parakeet v3');
});
test('legacy sessions do not claim an unknown transcription model',()=>{
 render(<SessionItem {...props} session={{...session,language:'en'}}/>);
 expect(screen.getByText(/English/)).toBeInTheDocument();expect(screen.queryByText(/Live:|Final:/)).not.toBeInTheDocument();
});
