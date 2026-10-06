import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {StorageSettings} from './StorageSettings';
const fixture={limitBytes:2_000_000_000,usedBytes:1000,reservedBytes:100,protectedBytes:500,reclaimableBytes:600,availableBytes:1_999_998_900,categories:{text:200,media:600,indexes:100,staging:100}};
const api=vi.hoisted(()=>({status:vi.fn(),preview:vi.fn(),apply:vi.fn()}));
vi.mock('@/api/storage',()=>({storageApi:api}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('shows authoritative decimal GB and requires reviewed confirmation before removing local media',async()=>{
 api.status.mockResolvedValue(fixture);api.preview.mockResolvedValue({...fixture,requestedLimit:1_000_000_000,removals:[{path:'/synthetic/old.wav',bytes:100}],token:'review'});api.apply.mockResolvedValue({...fixture,limitBytes:1_000_000_000});
 render(<StorageSettings/>);const input=await screen.findByLabelText('Maximum local meeting data (GB)');expect(input).toHaveValue(2);
 fireEvent.change(input,{target:{value:'1'}});fireEvent.click(screen.getByRole('button',{name:'Review change'}));
 expect(await screen.findByText('Review storage change')).toBeInTheDocument();expect(api.apply).not.toHaveBeenCalled();
 expect(screen.getByText(/old.wav/)).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Confirm storage change'}));
 await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('Storage limit saved.'));expect(input).toHaveValue(1);
});
it('rejects invalid values without submitting and preserves the previous limit after blocked reduction',async()=>{
 api.status.mockResolvedValue(fixture);api.preview.mockRejectedValue(new Error('Requested quota is below protected meeting data and reservations'));
 render(<StorageSettings/>);const input=await screen.findByLabelText('Maximum local meeting data (GB)');fireEvent.change(input,{target:{value:'0'}});fireEvent.click(screen.getByRole('button',{name:'Review change'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Choose a storage limit');expect(api.preview).not.toHaveBeenCalled();
 fireEvent.change(input,{target:{value:'1'}});fireEvent.click(screen.getByRole('button',{name:'Review change'}));
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Requested quota is below protected meeting data'));expect(api.apply).not.toHaveBeenCalled();
});
it('reset previews the decimal default and allows cancellation without saving',async()=>{
 api.status.mockResolvedValue({...fixture,limitBytes:4_000_000_000});api.preview.mockResolvedValue({...fixture,requestedLimit:2_000_000_000,removals:[],token:'review'});
 render(<StorageSettings/>);await screen.findByLabelText('Maximum local meeting data (GB)');fireEvent.click(screen.getByRole('button',{name:'Reset to 2 GB'}));
 await screen.findByText('Review storage change');fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(api.apply).not.toHaveBeenCalled();expect(screen.queryByText('Review storage change')).not.toBeInTheDocument();
});
