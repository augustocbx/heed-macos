import { expect, test } from 'bun:test';
import { DesktopPermissions, desktopRequestAllowed, permissionAction, permissionReport } from './desktop-permissions';
import { DesktopControl } from './desktop-control';
const snapshot = { microphone:'authorized' as const, screenCapture:true, slackLogs:false, slackAutoRecord:true };

test('does not invent permissions or connectivity without a native report', () => {
 expect(new DesktopPermissions().status(1000)).toEqual({controllerConnected:false,updatedAt:null,permissions:null,error:null,pending:false});
});
test('recent report expires after twelve seconds and keeps its actual timestamp', () => {
 const bridge = new DesktopPermissions();
 bridge.report({permissions:snapshot},1000);
 expect(bridge.status(12999).permissions).toEqual(snapshot);
 expect(bridge.status(13000)).toEqual({controllerConnected:false,updatedAt:1000,permissions:null,error:null,pending:false});
});
test('request keeps the same ID until a matching acknowledgement', () => {
 const bridge = new DesktopPermissions();
 const id = bridge.enqueue('microphone',1000);
 expect(bridge.request(1001)).toEqual({id,action:'microphone'});
 expect(bridge.request(1002)).toEqual({id,action:'microphone'});
 bridge.report({permissions:snapshot},1003);
 expect(bridge.status(1003).pending).toBe(true);
 bridge.report({permissions:snapshot,commandId:'outro'},1004);
 expect(bridge.status(1004).pending).toBe(true);
 bridge.report({permissions:snapshot,commandId:id,error:'The user denied permission.'},1005);
 expect(bridge.request(1006)).toBeNull();
 expect(bridge.status(1006).error).toBe('The user denied permission.');
});
test('request expires after ninety seconds without blocking the next attempt', () => {
 const bridge = new DesktopPermissions();
 bridge.enqueue('screenCapture',1000);
 expect(() => bridge.enqueue('slackLogs',1001)).toThrow('already pending');
 expect(bridge.request(90999)).not.toBeNull();
 expect(bridge.request(91000)).toBeNull();
 expect(bridge.status(91000).error).toContain('expired');
 bridge.enqueue('slackLogs',91001);
 expect(bridge.status(91001).pending).toBe(true);
 expect(bridge.status(91001).error).toBeNull();
});
test('unknown or unavailable permissions remain explicit', () => {
 const bridge = new DesktopPermissions();
 const permissions = {microphone:'unknown' as const,screenCapture:null,slackLogs:null,slackAutoRecord:null};
 bridge.report({permissions},1000);
 expect(bridge.status(1001).permissions).toEqual(permissions);
 permissions.slackLogs = null;
});
test('validators reject incomplete fields and invalid types', () => {
 for (const body of [null,[],{}, {permissions:null}, {permissions:{}},
  {permissions:{...snapshot,microphone:'granted'}}, {permissions:{...snapshot,screenCapture:1}},
  {permissions:{...snapshot,slackLogs:'true'}}, {permissions:{...snapshot,slackAutoRecord:undefined}},
  {permissions:snapshot,commandId:22}, {permissions:snapshot,commandId:''},
  {permissions:snapshot,error:22}]) expect(permissionReport(body)).toBeNull();
 expect(permissionReport({permissions:snapshot,error:null,commandId:'id'})).toEqual({permissions:snapshot,error:null,commandId:'id'});
 for (const action of ['start',null,{},['microphone'],42]) expect(permissionAction({action})).toBeNull();
 expect(permissionAction({action:'slackLogs'})).toBe('slackLogs');
});
test('blocks remote hosts, external origins, and different ports', () => {
 const request = (host:string,origin?:string) => new Request(`http://${host}:5001/api/desktop/permissions`,{headers:origin?{origin}:{}});
 expect(desktopRequestAllowed(request('localhost'),5001)).toBe(true);
 expect(desktopRequestAllowed(request('127.0.0.1','http://localhost:5170'),5001)).toBe(true);
 expect(desktopRequestAllowed(request('[::1]','http://[::1]:5001'),5001)).toBe(true);
 for (const origin of ['https://evil.example','null','http://localhost:1234','ftp://localhost:5170']) {
  expect(desktopRequestAllowed(request('localhost',origin),5001)).toBe(false);
 }
 expect(desktopRequestAllowed(request('192.168.50.219'),5001)).toBe(false);
});
test('permission queue is independent of recording', () => {
 const permissions = new DesktopPermissions();
 const recording = new DesktopControl();
 recording.enqueue('start','pt',{recording:false,processing:false},1000);
 const id = permissions.enqueue('microphone',1001);
 permissions.report({permissions:snapshot,commandId:id},1002);
 expect(recording.pending).toBe(true);
 expect(permissions.status(1002).pending).toBe(false);
});
