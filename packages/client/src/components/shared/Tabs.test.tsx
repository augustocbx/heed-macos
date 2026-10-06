import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect,test,vi} from 'vitest';
import {Tabs} from './Tabs';
import {setLocale} from '@/lib/i18n';
test('meeting task tabs are reachable and activatable with the keyboard',async()=>{
 setLocale('en');const change=vi.fn();render(<Tabs tabs={[{id:'tasks',label:'Tasks'},{id:'notes',label:'AI Notes',disabled:true}]} active="tasks" onChange={change}/>);
 const user=userEvent.setup();await user.tab();expect(screen.getByRole('button',{name:'Tasks'})).toHaveFocus();await user.keyboard('{Enter}');expect(change).toHaveBeenCalledWith('tasks');expect(screen.getByRole('button',{name:'AI Notes'})).toBeDisabled();
});
