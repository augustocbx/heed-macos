import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionsPage } from './PermissionsPage.tsx';

const state = (permissions: unknown, controllerConnected = true) => ({ controllerConnected, updatedAt: Date.now(), permissions, error: null, pending: false });
const authorized = { microphone: 'authorized', screenCapture: true, slackLogs: true, slackAutoRecord: true };
let snapshot: unknown;
let responseError = false;
const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => ({ ok: !responseError || !init, status: 409, statusText: 'Conflict', json: async () => init ? responseError ? { error: 'controller unavailable' } : { ok: true, id: '1' } : snapshot }));
beforeEach(() => { snapshot = state(authorized); responseError = false; vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
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
});

vi.mock('@/api/automaticNotes', () => ({ automaticNotesApi: {
 settings: vi.fn(async () => ({ enabled: false, model: null, templateId: 'general', language: 'meeting' })),
 models: vi.fn(async () => ({ models: [] })),
} }));
vi.mock('@/api/templates', () => ({ templatesApi: { list: vi.fn(async () => [{ id: 'general', name: 'General', prompt: '' }]) } }));

vi.mock("./MeetingDetectionSettings", () => ({ MeetingDetectionSettings: () => null }));
vi.mock("@/api/storage",()=>({storageApi:{status:vi.fn(async()=>({limitBytes:2_000_000_000,usedBytes:0,reservedBytes:0,protectedBytes:0,reclaimableBytes:0,availableBytes:2_000_000_000,categories:{text:0,media:0,indexes:0,staging:0}}))}}));
