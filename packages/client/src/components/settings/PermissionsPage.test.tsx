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
describe('configurações de permissões', () => {
 it('confirma autorização somente quando o aplicativo está conectado e os estados são conhecidos', async () => {
  const view = render(<PermissionsPage />);
  expect(await screen.findByText('Permissões autorizadas')).toBeInTheDocument();
  snapshot = state(authorized, false); fireEvent.click(screen.getByRole('button', { name: 'Verificar novamente' }));
  await screen.findByText('Aplicativo Heed desconectado');
  expect(screen.queryByText('Permissões autorizadas')).not.toBeInTheDocument();
  expect(screen.getAllByText('Não verificado')).toHaveLength(3);
  view.unmount();
 });
 it('permite renovar as autorizações existentes e informa falhas do aplicativo', async () => {
  snapshot = { ...state(authorized), error: 'Autorização cancelada' };
  render(<PermissionsPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Autorização cancelada');
  expect(screen.getByRole('button', { name: 'Abrir ajustes do microfone' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Abrir ajustes do áudio do sistema' })).toBeEnabled();
 });
 it('mostra permissões ausentes e envia cada autorização para o aplicativo nativo', async () => {
  snapshot = state({ ...authorized, microphone: 'denied', screenCapture: false, slackLogs: false });
  render(<PermissionsPage />);
  await screen.findByText('Permissões pendentes');
  for (const [name, action] of [['Abrir ajustes do microfone', 'microphone'], ['Autorizar áudio do sistema', 'screenCapture'], ['Autorizar registros do Slack', 'slackLogs']]) {
   fireEvent.click(screen.getByRole('button', { name }));
   await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.body === JSON.stringify({ action }))).toBe(true));
   await waitFor(() => expect(screen.getByRole('button', { name })).toBeEnabled());
  }
 });
 it('não confunde estados desconhecidos ou Slack opcional com autorização', async () => {
  snapshot = state({ microphone: 'unknown', screenCapture: null, slackLogs: null, slackAutoRecord: false });
  render(<PermissionsPage />);
  await screen.findByText('Verificação incompleta');
  expect(screen.getByText('Opcional — gravação automática desativada')).toBeInTheDocument();
  expect(screen.queryByText('Permissões autorizadas')).not.toBeInTheDocument();
 });
 it('mostra falha na ação sem afirmar que a permissão foi concedida', async () => {
  snapshot = state({ ...authorized, microphone: 'notDetermined' }); responseError = true;
  render(<PermissionsPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Autorizar microfone' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível abrir a autorização');
  expect(screen.queryByText('Permissões autorizadas')).not.toBeInTheDocument();
 });
 it('atualiza automaticamente as permissões a cada três segundos', async () => {
  vi.useFakeTimers(); snapshot = state({ ...authorized, microphone: 'denied' });
  render(<PermissionsPage />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText('Permissões pendentes')).toBeInTheDocument();
  snapshot = state(authorized);
  await act(async () => { vi.advanceTimersByTime(3000); await Promise.resolve(); });
  expect(screen.getByText('Permissões autorizadas')).toBeInTheDocument();
 });
 it('verifica novamente quando o usuário volta dos Ajustes', async () => {
  snapshot = state({ ...authorized, microphone: 'denied' }); render(<PermissionsPage />);
  await screen.findByText('Permissões pendentes'); snapshot = state(authorized);
  act(() => window.dispatchEvent(new Event('focus')));
  expect(await screen.findByText('Permissões autorizadas')).toBeInTheDocument();
 });
});
