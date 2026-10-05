import { test, expect } from 'bun:test';
import { DesktopControl } from './desktop-control';

test('only one browser can claim a menu command', () => {
 const control = new DesktopControl();
 control.enqueue('start', 'pt', {recording:false, processing:false});
 const claimed = control.claim('first');
 expect(claimed?.language).toBe('pt');
 expect(control.claim('second')).toBeNull();
 control.complete(claimed!.id, 'first', null);
 expect(control.pending).toBe(false);
});
test('duplicate start cannot replace an active recording', () => {
 const control = new DesktopControl();
 expect(() => control.enqueue('start', 'en', {recording:true, processing:false})).toThrow('already recording');
});
test('another connected tab can stop an active native recording', () => {
 const control = new DesktopControl();
 control.heartbeat('owner', {recording:true, processing:false, seconds:12}, 1000);
 control.enqueue('stop', 'pt', {recording:true, processing:false}, 1001);
 expect(control.claim('other', 1002)?.action).toBe('stop');
 expect(control.claim('owner', 1002)).toBeNull();
});
test('expired unclaimed command does not start recording later', () => {
 const control = new DesktopControl();
 control.enqueue('start', 'pt', {recording:false, processing:false}, 1000);
 expect(control.claim('late', 100000)).toBeNull();
 expect(control.error).toContain('expired');
});
test('a failed command is visible to the menu', () => {
 const control = new DesktopControl();
 control.enqueue('start', 'pt', {recording:false, processing:false});
 const command = control.claim('browser')!;
 control.complete(command.id, 'browser', 'Microphone permission denied');
 expect(control.error).toBe('Microphone permission denied');
});
test('lost command response releases the pending claim without replaying capture', () => {
 const control = new DesktopControl();
 control.enqueue('start', 'pt', {recording:false,processing:false},1000);
 control.claim('gone',1001);
 expect(control.claim('new',30000)).toBeNull();
 expect(control.pending).toBe(false);
 expect(control.error).toContain('disconnected');
});
test('executing commands keep their lease while finalization runs', () => {
 const control = new DesktopControl();
 control.enqueue('stop','pt',{recording:true,processing:false},1000);
 const command=control.claim('owner',1001)!;
 control.heartbeat('owner',{recording:false,processing:true,seconds:12,commandId:command.id},19000);
 expect(control.claim('new',20000)).toBeNull();
 expect(control.pending).toBe(true);
});
test('server takeover clears an automatic stop before a later start', () => {
 const bridge = new DesktopControl();
 bridge.enqueue('stop','pt',{recording:true,processing:false});
 bridge.cancelPending();
 expect(bridge.pending).toBe(false);
 expect(bridge.enqueue('start','pt',{recording:false,processing:false})).toBeTruthy();
});

test('an executing browser cannot silently consume a subsequent stop command', () => {
 const control = new DesktopControl();
 control.enqueue('stop','en',{recording:true,processing:false},1000);
 expect(control.claim('busy',1001,'previous-start')).toBeNull();
 expect(control.claim('available',1002)?.action).toBe('stop');
});
