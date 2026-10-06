import {afterEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {ServiceNotices} from './ServiceNotices';
import {useHealthStore} from '@/stores/health';
import {setLocale} from '@/lib/i18n';
import {StatusFix} from './StatusFix';
afterEach(()=>{cleanup();setLocale('en');});
test.each(['en','pt-BR','fr','de'] as const)('%s shows actionable safe service/port/app conflict and rechecks',locale=>{
 setLocale(locale);const check=vi.fn();useHealthStore.setState({health:{ollama:false,whisper:false,pyannote:false,services:[{service:'transcription',port:48102,state:'conflict',application:'Ruby'}]},check});
 render(<ServiceNotices/>);expect(screen.getByRole('status').textContent).toContain('48102');expect(screen.getByRole('status').textContent).toContain('Ruby');
 expect(screen.getByRole('status').textContent).not.toContain('fallback');fireEvent.click(screen.getByRole('button'));expect(check).toHaveBeenCalledWith(true);
 if(locale!=='en')expect(screen.getByRole('status').textContent).not.toContain('Another application');
});
test('stopped, starting and unhealthy remain distinct, and a recovered service hides the notice',()=>{
 for(const state of ['stopped','starting','unhealthy'] as const){useHealthStore.setState({health:{ollama:false,whisper:false,pyannote:false,services:[{service:'api',port:48100,state}]}});const view=render(<ServiceNotices/>);expect(screen.getByRole('status').textContent?.toLowerCase()).toContain(state==='unhealthy'?'not healthy':state);view.unmount();}
 useHealthStore.setState({health:{ollama:true,whisper:true,pyannote:true,services:[{service:'api',port:48100,state:'ready'}]}});render(<ServiceNotices/>);expect(screen.queryByRole('status')).toBeNull();
});
test('failed diagnosis shows unknown status and replaces a speculative engine repair without disabling recording',()=>{
 useHealthStore.setState({health:{ollama:false,whisper:false,pyannote:false},diagnosticsUnavailable:true});
 const view=render(<ServiceNotices/>);expect(screen.getByRole('status').textContent).toContain('Could not diagnose Heed services');view.unmount();
 render(<StatusFix target="engine" setup={null} onClose={vi.fn()} onFixed={vi.fn()}/>);
 expect(screen.queryByText('npx create-heed fallback')).toBeNull();expect(screen.getByRole('status').textContent).toContain('not verified');
});
