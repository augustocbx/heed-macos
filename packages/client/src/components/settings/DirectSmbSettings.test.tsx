import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DirectSmbSettings } from './DirectSmbSettings';
import { SmbSettings } from './SmbSettings';
import { useLocaleStore } from '@/stores/locale';
const endpoint = { server: 'files.example', port: 445, share: 'meetings', folder: '', requireEncryption: false };
const capabilities = { read: true, write: true, authentication: 'authenticated', dialect: '3.1.1', security: 'signed', encrypted: false, durability: 'share-readback', remoteDeletion: true };
const connection = { id: 'displayed-id', generation: 'displayed-generation', name: 'Office', endpoint, destinationId: 'destination', enabled: true, capabilities, progress: { pending: 2, nextRetryAt: null, lastSync: null, imported: 3, skipped: 1 }, error: null };
const empty = { recoveryRequired: false, syncing: false, connections: [] };
const preview = () => ({ receipt: 'review-receipt', expiresAt: Date.now() + 300000, endpoint, destinationId: null, needsCreation: true, capabilities });
let status: unknown; let testResult: unknown; let failure: { status: number; code: string } | null; let mutation: unknown;
const network = vi.fn();
beforeEach(() => {
 useLocaleStore.setState({locale:'en'}); status = empty; testResult = preview(); failure = null; mutation = empty; network.mockReset();
 network.mockImplementation(async (_url: string, init: RequestInit = {}) => {
  if (!init.body) return Response.json(status);
  const body = JSON.parse(init.body as string);
  if (failure) return Response.json({ error: 'secret account /private/path', code: failure.code }, { status: failure.status });
  return Response.json(body.action === 'test' ? testResult : mutation);
 });
 vi.stubGlobal('fetch', network);
});
const bodyCalls = () => network.mock.calls.filter(([,init])=>init.body).map(([,init])=>JSON.parse(init.body));
async function fillAndTest() {
 await screen.findByRole('button', { name: 'Test direct connection' });
 fireEvent.change(screen.getByLabelText('Direct destination name'), { target: { value: 'Office' } });
 fireEvent.change(screen.getByLabelText('Server'), { target: { value: 'files.example' } });
 fireEvent.change(screen.getByLabelText('Share'), { target: { value: 'meetings' } });
 fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'account' } });
 fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
 fireEvent.click(screen.getByRole('button', { name: 'Test direct connection' }));
}
describe('direct SMB settings', () => {
 it('reviews security and namespace separately and requires explicit empty-folder creation before connect', async () => {
  const changed = vi.fn(); render(<DirectSmbSettings onProviderChanged={changed}/>); await fillAndTest();
  const create = await screen.findByLabelText('Create a Heed Library in this verified empty folder');
  expect(screen.getByText('Authentication verified')).toBeInTheDocument(); expect(screen.getByText('Namespace safety verified')).toBeInTheDocument();
  expect(screen.getByText('SMB signing verified')).toBeInTheDocument(); expect(screen.getByText('3.1.1')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Connect reviewed destination' })).toBeDisabled();
  fireEvent.click(create); fireEvent.click(screen.getByRole('button', { name: 'Connect reviewed destination' }));
  await waitFor(()=>expect(screen.getByLabelText('Password')).toHaveValue(''));
  expect(bodyCalls()[1]).toEqual({ action:'connect',name:'Office',receipt:'review-receipt',create:true });
  expect(changed).toHaveBeenCalledOnce(); expect(screen.queryByLabelText('Create a Heed Library in this verified empty folder')).toBeNull();
 });
 it.each(['Server','Port','Share','Folder','Account','Domain','Password','Require SMB encryption'])('invalidates reviewed receipt and creation after %s changes', async label => {
  render(<DirectSmbSettings/>); await fillAndTest(); fireEvent.click(await screen.findByLabelText('Create a Heed Library in this verified empty folder'));
  const control = screen.getByLabelText(label); if(label==='Require SMB encryption')fireEvent.click(control); else fireEvent.change(control,{target:{value:'changed'}});
  expect(screen.queryByRole('button',{name:'Connect reviewed destination'})).toBeNull();
 });
 it.each(['read-only','unsupported-coordination','unsupported-security','unsupported-namespace'])('refuses %s without rendering raw diagnostics',async code=>{
  failure={status:503,code}; render(<DirectSmbSettings/>); await fillAndTest();
  const alert=await screen.findByRole('alert'); expect(alert).not.toHaveTextContent('secret'); expect(alert).not.toHaveTextContent('/private/path');
  if(code==='read-only') expect(alert).toHaveTextContent('Direct SMB requires write access for coordination. Use the mounted option for read-only imports.');
  expect(screen.queryByRole('button',{name:'Connect reviewed destination'})).toBeNull();
 });
 it('preserves mounted read-only import alongside direct coordination refusal',async()=>{
  status={...empty, selectedFolder:null,desktopPending:false,desktopError:null,connections:[{id:'mounted',name:'Mounted',root:'/fixture/Heed Library',destinationId:'d',enabled:true,readOnly:true,security:'signed',pending:0,lastSync:null,error:null,imported:1,skipped:0,bytes:0}]};
  render(<SmbSettings/>); expect(await screen.findByText(/Read-only — imports available/)).toBeInTheDocument();
 });
 it('submits displayed ID and generation for rename, enable, disconnect and sync',async()=>{
  status={...empty,connections:[connection]}; mutation=status; render(<DirectSmbSettings/>);
  const section=await screen.findByRole('region',{name:'Office'});
  fireEvent.change(within(section).getByLabelText('Rename direct destination'),{target:{value:'New name'}});
  for(const name of ['Save direct name','Disable direct destination','Synchronize direct destination','Disconnect direct destination']){
   fireEvent.click(within(section).getByRole('button',{name})); await waitFor(()=>expect(within(section).getByRole('button',{name})).toBeEnabled());
  }
  expect(bodyCalls()).toEqual([{action:'rename',id:'displayed-id',generation:'displayed-generation',name:'New name'},{action:'enable',id:'displayed-id',generation:'displayed-generation',enabled:false},{action:'sync',id:'displayed-id',generation:'displayed-generation'},{action:'disconnect',id:'displayed-id',generation:'displayed-generation'}]);
  expect(screen.getByText('Imported: 3; skipped: 1; pending: 2.')).toBeInTheDocument();
 });
 it('refreshes generation conflict without silently retrying the stale action',async()=>{
  status={...empty,connections:[connection]}; render(<DirectSmbSettings/>); await screen.findByRole('region',{name:'Office'});
  status={...empty,connections:[{...connection,generation:'new-generation'}]}; failure={status:409,code:'stale-generation'};
  fireEvent.click(screen.getByRole('button',{name:'Disable direct destination'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('This connection changed. Review the refreshed status before trying again.');
  await waitFor(()=>expect(network.mock.calls.filter(([,init])=>!init.body)).toHaveLength(2));
  expect(bodyCalls()).toHaveLength(1); expect(bodyCalls()[0].generation).toBe('displayed-generation');
 });
 it('allows only explicit original-operation recovery while ordinary controls remain blocked',async()=>{
  status={...empty,recoveryRequired:true,connections:[connection]}; mutation={...empty,connections:[connection]}; render(<DirectSmbSettings/>);
  const recover=await screen.findByRole('button',{name:'Recover original direct operation'});
  expect(screen.getByRole('button',{name:'Disable direct destination'})).toBeDisabled(); expect(screen.getByRole('button',{name:'Test direct connection'})).toBeDisabled();
  expect(bodyCalls()).toHaveLength(0); fireEvent.click(recover);
  await waitFor(()=>expect(bodyCalls()).toEqual([{action:'sync',id:'displayed-id',generation:'displayed-generation'}]));
  expect(await screen.findByRole('button',{name:'Synchronize direct destination'})).toBeEnabled();
 });
 it('keeps ordinary controls blocked during server syncing and sanitizes pending snapshot errors',async()=>{
  status={...empty,syncing:true,connections:[{...connection,error:{code:'unknown-private',message:'secret account /private/path'}}]}; render(<DirectSmbSettings/>);
  expect(await screen.findByRole('button',{name:'Disable direct destination'})).toBeDisabled(); expect(screen.getByRole('button',{name:'Test direct connection'})).toBeDisabled();
  expect(screen.getByRole('alert')).not.toHaveTextContent('secret'); expect(bodyCalls()).toHaveLength(0);
 });
 it('clears password on cancel and never writes browser storage',async()=>{
  const local=vi.spyOn(Storage.prototype,'setItem'); render(<DirectSmbSettings/>); await fillAndTest(); await screen.findByLabelText('Create a Heed Library in this verified empty folder');
  fireEvent.click(screen.getByRole('button',{name:'Cancel direct review'})); expect(screen.getByLabelText('Password')).toHaveValue(''); expect(screen.getByLabelText('Account')).toHaveValue(''); expect(local).not.toHaveBeenCalled(); local.mockRestore();
 });
 it('discards late test after cancel',async()=>{
  let resolve!:(response:Response)=>void;
  network.mockImplementation((_url,init)=>init.body?new Promise<Response>(r=>{resolve=r;}):Promise.resolve(Response.json(empty)));
  const view=render(<DirectSmbSettings/>); await fillAndTest();
  fireEvent.click(screen.getByRole('button',{name:'Cancel direct review'})); expect(screen.getByLabelText('Password')).toHaveValue('');
  resolve(Response.json(preview())); await waitFor(()=>expect(screen.getByRole('button',{name:'Cancel direct review'})).toBeEnabled());
  expect(screen.getByLabelText('Password')).toHaveValue(''); expect(screen.queryByRole('button',{name:'Connect reviewed destination'})).toBeNull();
  view.unmount(); expect(network.mock.calls[1][1].signal.aborted).toBe(true);
 });
 it('requires another test after an expired receipt and never silently connects again',async()=>{
  render(<DirectSmbSettings/>); await fillAndTest(); fireEvent.click(await screen.findByLabelText('Create a Heed Library in this verified empty folder')); failure={status:409,code:'receipt-expired'};
  fireEvent.click(screen.getByRole('button',{name:'Connect reviewed destination'})); expect(await screen.findByRole('alert')).toHaveTextContent('The review expired. Test this connection again.');
  expect(screen.queryByRole('button',{name:'Connect reviewed destination'})).toBeNull(); expect(bodyCalls()).toHaveLength(2);
 });
 it('retests the displayed endpoint and connects replacement with its paired generation',async()=>{
  status={...empty,connections:[connection]}; mutation=status; render(<DirectSmbSettings/>); fireEvent.click(await screen.findByRole('button',{name:'Retest direct destination'}));
  expect(screen.getByLabelText('Server')).toHaveValue('files.example'); expect(screen.getByLabelText('Account')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Account'),{target:{value:'account'}}); fireEvent.change(screen.getByLabelText('Password'),{target:{value:'secret'}});
  fireEvent.click(screen.getByRole('button',{name:'Test direct connection'})); fireEvent.click(await screen.findByLabelText('Create a Heed Library in this verified empty folder'));
  fireEvent.click(screen.getByRole('button',{name:'Connect reviewed destination'})); await waitFor(()=>expect(bodyCalls()).toHaveLength(2));
  expect(bodyCalls()[1]).toEqual({action:'connect',name:'Office',receipt:'review-receipt',create:true,connectionId:'displayed-id',generation:'displayed-generation'});
 });
 it('maps prototype-shaped unknown codes to a static notice',async()=>{
  failure={status:503,code:'constructor'}; render(<DirectSmbSettings/>); await fillAndTest();
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not complete the direct SMB operation.');
 });
 it('rejects unsafe alternate remote ports before submitting credentials',async()=>{
  render(<DirectSmbSettings/>); await screen.findByRole('button',{name:'Test direct connection'});
  fireEvent.change(screen.getByLabelText('Port'),{target:{value:'48001'}}); await fillAndTest();
  expect(await screen.findByRole('alert')).toHaveTextContent('Use port 445'); expect(bodyCalls()).toHaveLength(0);
 });
 it('does not offer connect for unsupported successful capability previews',async()=>{
  testResult={...preview(),capabilities:{...capabilities,write:false}}; render(<DirectSmbSettings/>); await fillAndTest();
  expect(await screen.findByRole('alert')).toHaveTextContent('The connection review is unsupported or inconsistent.');
  expect(screen.queryByRole('button',{name:'Connect reviewed destination'})).toBeNull();
 });
 it('connects an existing accepted library without requesting creation',async()=>{
  testResult={...preview(),destinationId:'destination',needsCreation:false}; render(<DirectSmbSettings/>); await fillAndTest();
  const connect=await screen.findByRole('button',{name:'Connect reviewed destination'});
  expect(screen.queryByLabelText('Create a Heed Library in this verified empty folder')).toBeNull();fireEvent.click(connect);
  await waitFor(()=>expect(screen.getByLabelText('Password')).toHaveValue(''));
  expect(bodyCalls()[1]).toEqual({action:'connect',name:'Office',receipt:'review-receipt',create:false});
 });
 it('blocks unavailable recovery responses without offering an implicit recovery call',async()=>{
  network.mockResolvedValue(Response.json({code:'recovery-required',error:'secret'},{status:503})); render(<DirectSmbSettings/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Direct synchronization requires recovery.');
  expect(screen.getByRole('button',{name:'Test direct connection'})).toBeDisabled(); expect(bodyCalls()).toHaveLength(0);
 });
 it.each([
  ['en','Direct SMB connection','Password'],['pt-BR','Conexão SMB direta','Senha'],['fr','Connexion SMB directe','Mot de passe'],['de','Direkte SMB-Verbindung','Passwort'],
 ] as const)('renders actual %s labels',async(locale,title,password)=>{
  useLocaleStore.setState({locale}); render(<DirectSmbSettings/>); expect(screen.getByRole('heading',{name:title})).toBeInTheDocument();
  expect(screen.getByLabelText(password)).toHaveAttribute('type','password');
  await waitFor(()=>expect(network).toHaveBeenCalledOnce());
 });

 it('discards a canceled test after a newer endpoint has been reviewed',async()=>{
  let late!:(response:Response)=>void; let tests=0;
  network.mockImplementation((_url,init)=>{
   if(!init.body)return Promise.resolve(Response.json(empty));
   tests++; if(tests===1)return new Promise<Response>(resolve=>{late=resolve;});
   const sent=JSON.parse(init.body);return Promise.resolve(Response.json(sent.action==='test'?{...preview(),receipt:'new-review',endpoint:sent.endpoint}:empty));
  });
  render(<DirectSmbSettings/>);await fillAndTest();fireEvent.click(screen.getByRole('button',{name:'Cancel direct review'}));
  fireEvent.change(screen.getByLabelText('Server'),{target:{value:'new.example'}});
  fireEvent.change(screen.getByLabelText('Account'),{target:{value:'new-account'}});fireEvent.change(screen.getByLabelText('Password'),{target:{value:'new-secret'}});
  fireEvent.click(screen.getByRole('button',{name:'Test direct connection'}));await screen.findByLabelText('Create a Heed Library in this verified empty folder');
  await act(async()=>{late(Response.json({...preview(),receipt:'old-review'}));});
  fireEvent.click(screen.getByLabelText('Create a Heed Library in this verified empty folder'));
  fireEvent.click(screen.getByRole('button',{name:'Connect reviewed destination'}));
  await waitFor(()=>expect(bodyCalls()).toHaveLength(3));expect(bodyCalls()[2].receipt).toBe('new-review');
 });
 it('expires a review locally and requires testing again before connect',async()=>{
  testResult={...preview(),expiresAt:Date.now()+100};render(<DirectSmbSettings/>);await fillAndTest();
  await screen.findByLabelText('Create a Heed Library in this verified empty folder');
  expect(await screen.findByRole('alert')).toHaveTextContent('The review expired. Test this connection again.');
  expect(screen.queryByRole('button',{name:'Connect reviewed destination'})).toBeNull();expect(bodyCalls()).toHaveLength(1);
 });
 it('ignores status responses started before a reviewed mutation',async()=>{
  let stale!:(response:Response)=>void;let gets=0;
  status={...empty,connections:[connection]};mutation={...empty,connections:[{...connection,enabled:false}]};
  network.mockImplementation((_url,init)=>{
   if(init.body)return Promise.resolve(Response.json(mutation));
   gets++;return gets===1?Promise.resolve(Response.json(status)):new Promise<Response>(resolve=>{stale=resolve;});
  });
  render(<DirectSmbSettings/>);await screen.findByRole('region',{name:'Office'});
  fireEvent.click(screen.getByRole('button',{name:'Refresh direct status'}));
  fireEvent.click(screen.getByRole('button',{name:'Disable direct destination'}));
  await screen.findByText('Direct destination disabled');
  await act(async()=>{stale(Response.json(status));});
  expect(screen.getByText('Direct destination disabled')).toBeInTheDocument();
 });
 it('aborts an unmounted mutation and suppresses its provider callback',async()=>{
  let resolve!:(response:Response)=>void;status={...empty,connections:[connection]};const changed=vi.fn();
  network.mockImplementation((_url,init)=>init.body?new Promise<Response>(r=>{resolve=r;}):Promise.resolve(Response.json(status)));
  const view=render(<DirectSmbSettings onProviderChanged={changed}/>);fireEvent.click(await screen.findByRole('button',{name:'Disable direct destination'}));
  expect(screen.getByRole('button',{name:'Disconnect direct destination'})).toBeDisabled();
  view.unmount();expect(network.mock.calls[1][1].signal.aborted).toBe(true);
  await act(async()=>{resolve(Response.json(empty));});expect(changed).not.toHaveBeenCalled();
 });

 it('keeps stale controls blocked until conflict refresh has completed',async()=>{
  let refreshed!:(response:Response)=>void;let gets=0;
  status={...empty,connections:[connection]};
  network.mockImplementation((_url,init)=>{
   if(init.body)return Promise.resolve(Response.json({code:'stale-generation',error:'private'},{status:409}));
   gets++;return gets===1?Promise.resolve(Response.json(status)):new Promise<Response>(resolve=>{refreshed=resolve;});
  });
  render(<DirectSmbSettings/>);fireEvent.click(await screen.findByRole('button',{name:'Disable direct destination'}));
  await screen.findByRole('alert');expect(screen.getByRole('button',{name:'Disable direct destination'})).toBeDisabled();
  await act(async()=>{refreshed(Response.json({...empty,connections:[{...connection,generation:'refreshed-generation'}]}));});
  expect(screen.getByRole('button',{name:'Disable direct destination'})).toBeEnabled();expect(bodyCalls()).toHaveLength(1);
 });

 it('aborts a pending credential test on unmount and ignores its late review',async()=>{
  let resolve!:(response:Response)=>void;
  network.mockImplementation((_url,init)=>init.body?new Promise<Response>(r=>{resolve=r;}):Promise.resolve(Response.json(empty)));
  const view=render(<DirectSmbSettings/>);await fillAndTest();view.unmount();
  expect(network.mock.calls[1][1].signal.aborted).toBe(true);
  await act(async()=>{resolve(Response.json(preview()));});
  expect(screen.queryByLabelText('Password')).toBeNull();expect(screen.queryByRole('button',{name:'Connect reviewed destination'})).toBeNull();
 });

});
