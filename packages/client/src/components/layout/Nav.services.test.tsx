import {render,screen,cleanup,act,fireEvent} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import {Nav} from './Nav';
import {useHealthStore} from '@/stores/health';
import {useModelsStore} from '@/stores/models';
vi.mock('@/api/setup',()=>({setupApi:{check:vi.fn(async()=>null)}}));
afterEach(()=>cleanup());
test('conflicting or unknown transcription never displays invented CPU/model defaults',async()=>{
 useHealthStore.setState({health:{ollama:false,whisper:false,pyannote:false,services:[{service:'transcription',port:48102,state:'conflict'}]},check:vi.fn(async()=>{}),diagnosticsUnavailable:false});
 useModelsStore.setState({load:vi.fn(),data:null});
 await act(async()=>{render(<Nav/>);});
 expect(screen.queryAllByText('cpu')).toHaveLength(0);expect(screen.queryAllByText('small')).toHaveLength(0);
 fireEvent.click(screen.getByRole('button',{name:/System/}));
 expect(screen.getByText('No verified transcription profile.')).toBeInTheDocument();
 expect(screen.getByText('No verified diarization profile.')).toBeInTheDocument();
});
