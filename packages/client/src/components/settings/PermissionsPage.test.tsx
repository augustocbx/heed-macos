import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocaleStore } from '@/stores/locale.ts';
import { tr } from '@/lib/i18n.ts';
import { PermissionsPage } from './PermissionsPage.tsx';

const state = (permissions: unknown, controllerConnected = true) => ({ controllerConnected, updatedAt: Date.now(), permissions, error: null, pending: false });
const authorized = { microphone: 'authorized', screenCapture: true, slackLogs: true, slackAutoRecord: true };
let snapshot: unknown;
let responseError = false;
const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => ({ ok: !responseError || !init, status: 409, statusText: 'Conflict', json: async () => init ? responseError ? { error: 'controller unavailable' } : { ok: true, id: '1' } : snapshot }));
beforeEach(() => { useLocaleStore.getState().sync('en'); snapshot = state(authorized); responseError = false; vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('permission settings', () => {
 it('confirms authorization only when the app is connected and states are known', async () => {
  const view = render(<PermissionsPage />);
  expect(await screen.findByText('Permissions authorized')).toBeInTheDocument();
  snapshot = state(authorized, false); fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await screen.findByText('Heed app disconnected');
  expect(screen.queryByText('Permissions authorized')).not.toBeInTheDocument();
  expect(screen.getAllByText('Not checked')).toHaveLength(3);
  view.unmount();
 });
 it('allows renewing existing authorizations and reports app errors', async () => {
  snapshot = { ...state(authorized), error: 'Authorization canceled' };
  render(<PermissionsPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Authorization canceled');
  expect(screen.getByRole('button', { name: 'Open microphone settings' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Open system audio settings' })).toBeEnabled();
 });
 it('shows missing permissions and sends each authorization to the native app', async () => {
  snapshot = state({ ...authorized, microphone: 'denied', screenCapture: false, slackLogs: false });
  render(<PermissionsPage />);
  await screen.findByText('Permissions needed');
  for (const [name, action] of [['Open microphone settings', 'microphone'], ['Authorize system audio', 'screenCapture'], ['Authorize Slack logs', 'slackLogs']]) {
   fireEvent.click(screen.getByRole('button', { name }));
   await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.body === JSON.stringify({ action }))).toBe(true));
   await waitFor(() => expect(screen.getByRole('button', { name })).toBeEnabled());
  }
 });
 it('does not treat unknown states or optional Slack access as authorization', async () => {
  snapshot = state({ microphone: 'unknown', screenCapture: null, slackLogs: null, slackAutoRecord: false });
  render(<PermissionsPage />);
  await screen.findByText('Check incomplete');
  expect(screen.getByText('Optional — automatic recording disabled')).toBeInTheDocument();
  expect(screen.queryByText('Permissions authorized')).not.toBeInTheDocument();
 });
 it('reports action failure without claiming permission was granted', async () => {
  snapshot = state({ ...authorized, microphone: 'notDetermined' }); responseError = true;
  render(<PermissionsPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Authorize microphone' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not open authorization');
  expect(screen.queryByText('Permissions authorized')).not.toBeInTheDocument();
 });
 it('refreshes permissions automatically every three seconds', async () => {
  vi.useFakeTimers(); snapshot = state({ ...authorized, microphone: 'denied' });
  render(<PermissionsPage />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText('Permissions needed')).toBeInTheDocument();
  snapshot = state(authorized);
  await act(async () => { vi.advanceTimersByTime(3000); await Promise.resolve(); });
  expect(screen.getByText('Permissions authorized')).toBeInTheDocument();
 });
 it('checks again when the user returns from Settings', async () => {
  snapshot = state({ ...authorized, microphone: 'denied' }); render(<PermissionsPage />);
  await screen.findByText('Permissions needed'); snapshot = state(authorized);
  act(() => window.dispatchEvent(new Event('focus')));
  expect(await screen.findByText('Permissions authorized')).toBeInTheDocument();
 });
 it('requests native recovery without claiming authorization, then follows restart and fresh permissions', async () => {
  snapshot = { ...state({ ...authorized, screenCapture: false }), recoveryAvailable: true };
  render(<PermissionsPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Recover system audio permission' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.body === JSON.stringify({ action: 'recoverScreenCapture' }))).toBe(true));
  expect(await screen.findByText('Confirm recovery in the Heed window. Heed will restart, then macOS will ask for authorization.')).toBeInTheDocument();
  expect(screen.queryByText('Permissions authorized')).not.toBeInTheDocument();
  snapshot = { ...state(null, false), pending: true };
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(await screen.findByText('Restarting Heed to renew system audio access…')).toBeInTheDocument();
  snapshot = state(authorized);
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(await screen.findByText('Permissions authorized')).toBeInTheDocument();
  expect(screen.queryByText('Restarting Heed to renew system audio access…')).not.toBeInTheDocument();
 });
 it.each([
  { recoveryAvailable: false, recoveryBlockedReason: 'Wait for recording, transcription or other processing to finish before recovering system audio access.' },
  { recoveryAvailable: true, pending: true },
  {},
 ])('disables recovery when unavailable, busy, or unsupported: %o', async extra => {
  snapshot = { ...state({ ...authorized, screenCapture: false }), ...extra };
  render(<PermissionsPage />);
  expect(await screen.findByRole('button', { name: 'Recover system audio permission' })).toBeDisabled();
  if ('recoveryBlockedReason' in extra) expect(screen.getByText(extra.recoveryBlockedReason!)).toBeInTheDocument();
 });
 it('does not offer recovery without a connected app or a known missing system permission', async () => {
  snapshot = { ...state({ ...authorized, screenCapture: false }, false), recoveryAvailable: true };
  const view = render(<PermissionsPage />);
  await screen.findByText('Heed app disconnected');
  expect(screen.queryByRole('button', { name: 'Recover system audio permission' })).not.toBeInTheDocument();
  snapshot = { ...state({ ...authorized, screenCapture: null }), recoveryAvailable: true };
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await screen.findByText('Check incomplete');
  expect(screen.queryByRole('button', { name: 'Recover system audio permission' })).not.toBeInTheDocument();
  view.unmount();
 });
 it('prevents another recovery request while the native app awaits confirmation', async () => {
  snapshot = { ...state({ ...authorized, screenCapture: false }), recoveryAvailable: true };
  render(<PermissionsPage />);
  const button = await screen.findByRole('button', { name: 'Recover system audio permission' });
  snapshot = { ...state({ ...authorized, screenCapture: false }), recoveryAvailable: true, pending: true };
  fireEvent.click(button);
  await waitFor(() => expect(button).toBeDisabled());
  fireEvent.click(button);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.body === JSON.stringify({ action: 'recoverScreenCapture' }))).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Authorize system audio' })).toBeDisabled();
  expect(screen.queryByText('Permissions authorized')).not.toBeInTheDocument();
 });
 it('reports rejected recovery with a generic message and permits retry', async () => {
  snapshot = { ...state({ ...authorized, screenCapture: false }), recoveryAvailable: true };
  responseError = true;
  render(<PermissionsPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Recover system audio permission' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not start permission recovery. Make sure Heed is running and try again.');
  expect(screen.queryByText('controller unavailable')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Recover system audio permission' })).toBeEnabled();
 });
 it('clears recovery instructions even when native cancellation finishes before the first refresh', async () => {
  snapshot = { ...state({ ...authorized, screenCapture: false }), recoveryAvailable: true, pending: false };
  render(<PermissionsPage />);
  const button = await screen.findByRole('button', { name: 'Recover system audio permission' });
  snapshot = { ...state({ ...authorized, screenCapture: false }), recoveryAvailable: true, error: 'Permission recovery canceled.' };
  fireEvent.click(button);
  expect(await screen.findByRole('alert')).toHaveTextContent('Permission recovery canceled.');
  expect(screen.queryByText('Confirm recovery in the Heed window. Heed will restart, then macOS will ask for authorization.')).not.toBeInTheDocument();
  expect(button).toBeEnabled();
 });
 it('updates recovery copy when the interface locale changes', async () => {
  snapshot = { ...state({ ...authorized, screenCapture: false }), recoveryAvailable: true };
  render(<PermissionsPage />);
  await screen.findByRole('button', { name: 'Recover system audio permission' });
  act(() => useLocaleStore.getState().sync('pt-BR'));
  expect(screen.getByRole('button', { name: 'Recuperar permissão de áudio do sistema' })).toBeInTheDocument();
  for (const locale of ['pt-BR', 'fr', 'de'] as const) {
   expect(tr('Recover system audio permission', locale)).not.toBe('Recover system audio permission');
   expect(tr('Confirm recovery in the Heed window. Heed will restart, then macOS will ask for authorization.', locale)).not.toBe('Confirm recovery in the Heed window. Heed will restart, then macOS will ask for authorization.');
  }
 });

});

vi.mock('@/api/automaticNotes', () => ({ automaticNotesApi: {
 settings: vi.fn(async () => ({ enabled: false, model: null, templateId: 'general', language: 'meeting' })),
 models: vi.fn(async () => ({ models: [] })),
} }));
vi.mock('@/api/templates', () => ({ templatesApi: { list: vi.fn(async () => [{ id: 'general', name: 'General', prompt: '' }]) } }));

vi.mock("./MeetingDetectionSettings", () => ({ MeetingDetectionSettings: () => null }));
vi.mock("@/api/storage",()=>({storageApi:{status:vi.fn(async()=>({limitBytes:2_000_000_000,usedBytes:0,reservedBytes:0,protectedBytes:0,reclaimableBytes:0,availableBytes:2_000_000_000,categories:{text:0,media:0,indexes:0,staging:0}}))}}));
vi.mock('./StorageLibrarySettings',()=>({StorageLibrarySettings:()=>null}));

vi.mock("./SmbSettings", () => ({ SmbSettings: () => null }));
vi.mock('./OneDriveSettings',()=>({OneDriveSettings:()=>null}));
vi.mock('./ICloudFolderSettings',()=>({ICloudFolderSettings:()=>null}));

vi.mock('./VocabularySettings',()=>({VocabularySettings:()=>null}));
