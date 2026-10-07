import { afterEach, expect, test, vi } from 'vitest';
import { downloadMeetingExport } from './download';
afterEach(() => vi.restoreAllMocks());
test('uses a typed local Blob, safe filename and idempotent URL cleanup', () => {
 const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local'), revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
 const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { expect(this.download).toBe('Meeting-name.pdf'); expect(this.href).toBe('blob:local'); });
 const cleanup = downloadMeetingExport({ bytes: new Uint8Array([1, 2]), mime: 'application/pdf', extension: 'pdf', snapshotKey: 'key' }, '../Meeting/name\0');
 expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'application/pdf' })); expect(click).toHaveBeenCalledTimes(1);
 cleanup(); cleanup(); expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:local');
});
