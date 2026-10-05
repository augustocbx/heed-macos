import { describe, it, expect, vi } from 'vitest';
import { executeDesktopCommand } from './desktop-command';
describe('desktop recording control', () => {
 it('starts with the selected Portuguese language through the recording lifecycle', async () => {
  const start = vi.fn().mockResolvedValue(true);
  await executeDesktopCommand({action:'start',language:'pt'}, {recording:false,processing:false,ready:true}, {start,stop:vi.fn()});
  expect(start).toHaveBeenCalledWith('pt');
 });
 it('rejects a start while models are not ready', async () => {
  const start = vi.fn();
  await expect(executeDesktopCommand({action:'start',language:'en'}, {recording:false,processing:false,ready:false}, {start,stop:vi.fn()})).rejects.toThrow('preparing');
  expect(start).not.toHaveBeenCalled();
 });
 it('stops using the same lifecycle that saves the session', async () => {
  const stop = vi.fn().mockResolvedValue(true);
  await executeDesktopCommand({action:'stop',language:'en'}, {recording:true,processing:false,ready:true}, {start:vi.fn(),stop});
  expect(stop).toHaveBeenCalledWith('en');
 });
 it('reports permission/capture failures instead of acknowledging success', async () => {
  await expect(executeDesktopCommand({action:'start',language:'pt'}, {recording:false,processing:false,ready:true}, {start:vi.fn().mockResolvedValue(false),stop:vi.fn()})).rejects.toThrow('permission');
 });
});
