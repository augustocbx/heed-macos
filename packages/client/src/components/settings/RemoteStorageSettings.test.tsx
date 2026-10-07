import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {PermissionsPage} from './PermissionsPage';
import {directSmbApi} from '@/api/smb-direct';
import {smbApi} from '@/api/smb';
import {icloudApi} from '@/api/icloud';
import {useLocaleStore} from '@/stores/locale';
import {StorageLibrarySettings} from './StorageLibrarySettings';
import {permissionsApi} from '@/api/permissions.ts';

vi.mock('@/api/permissions.ts', () => ({permissionsApi: {status: vi.fn()}}));
vi.mock('@/api/smb-direct', () => ({directSmbApi: {status: vi.fn(), test: vi.fn(), connect: vi.fn()}}));
vi.mock('@/api/smb', () => ({smbApi: {status: vi.fn(), test: vi.fn(), connect: vi.fn(), rename: vi.fn(), enable: vi.fn(), disconnect: vi.fn(), sync: vi.fn(), folder: vi.fn(), mount: vi.fn()}}));
vi.mock('@/api/icloud', () => ({icloudApi: {request: vi.fn()}}));
vi.mock('@/components/ai-notes/AutomaticNotesSettings', () => ({AutomaticNotesSettings: () => null}));
vi.mock('./MeetingDetectionSettings', () => ({MeetingDetectionSettings: () => null}));
vi.mock('./StorageSettings', () => ({StorageSettings: () => null}));
vi.mock('./StorageLibrarySettings', () => ({StorageLibrarySettings: vi.fn(() => <p>Shared remote library</p>)}));
vi.mock('./GoogleDriveSettings', () => ({GoogleDriveSettings: () => <p>Google Drive</p>}));
vi.mock('./OneDriveSettings', () => ({OneDriveSettings: () => <p>Microsoft OneDrive</p>}));

const smbSnapshot = {connections: [{id: 'existing-smb', name: 'Existing SMB library', root: '/share/Heed Library', destinationId: 'destination', enabled: true, readOnly: false, security: 'signed' as const, pending: 2, imported: 1, skipped: 0, bytes: 100, lastSync: null, error: null}], syncing: false, selectedFolder: null, desktopPending: false, desktopError: null};
const icloudSnapshot = {connection: {id: 'existing-icloud', name: 'Existing iCloud library', destinationId: 'cloud-destination', enabled: true, pending: 2, status: 'connected', observations: {}}, syncing: false, error: null, preview: null, remoteChecksumVerified: false as const, confirmation: 'local-only' as const};
beforeEach(() => {
 vi.resetAllMocks();
 vi.mocked(directSmbApi.status).mockResolvedValue({connections:[],syncing:false,recoveryRequired:false});
 useLocaleStore.setState({locale: 'en'});
 vi.mocked(permissionsApi.status).mockResolvedValue({controllerConnected: true, updatedAt: 0, error: null, pending: false, permissions: {microphone: 'authorized', screenCapture: true, slackLogs: true, slackAutoRecord: true}});
 vi.mocked(smbApi.status).mockResolvedValue(smbSnapshot);
 vi.mocked(smbApi.rename).mockResolvedValue(smbSnapshot);
 vi.mocked(icloudApi.request).mockResolvedValue(icloudSnapshot);
});

describe('remote storage settings', () => {
 it('starts with an explicit choice and excludes unavailable account providers', async () => {
  render(<PermissionsPage/>);
  await screen.findByText('Permissions authorized');
  const selector = screen.getByRole('combobox', {name: 'Remote storage provider'});
  expect(selector).toHaveValue('');
  expect(within(selector).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose remote storage', 'SMB/Samba', 'iCloud Drive']);
  expect(screen.queryByText(/Google Drive|OneDrive/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Destination name')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', {name: 'Choose iCloud folder'})).not.toBeInTheDocument();
  expect(smbApi.status).not.toHaveBeenCalled();
  expect(icloudApi.request).not.toHaveBeenCalled();
 });

 it('exposes direct and mounted SMB only after explicit SMB selection', async()=>{
  render(<PermissionsPage/>);
  expect(directSmbApi.status).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox',{name:'Remote storage provider'}),{target:{value:'smb'}});
  expect(await screen.findByRole('heading',{name:'Direct SMB connection'})).toBeInTheDocument();
  expect(await screen.findByRole('heading',{name:'Existing SMB library'})).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox',{name:'Remote storage provider'}),{target:{value:'icloud'}});
  expect(screen.queryByRole('heading',{name:'Direct SMB connection'})).not.toBeInTheDocument();
 });

 it('shows one provider form at a time without changing existing connections', async () => {
  render(<PermissionsPage/>);
  const selector = screen.getByRole('combobox', {name: 'Remote storage provider'});
  fireEvent.change(selector, {target: {value: 'smb'}});
  expect(await screen.findByRole('heading', {name: 'Existing SMB library'})).toBeInTheDocument();
  expect(screen.queryByRole('button', {name: 'Choose iCloud folder'})).not.toBeInTheDocument();
  fireEvent.change(selector, {target: {value: 'icloud'}});
  expect(await screen.findByText('Existing iCloud library')).toBeInTheDocument();
  expect(screen.queryByLabelText('Destination name')).not.toBeInTheDocument();
  fireEvent.change(selector, {target: {value: ''}});
  expect(screen.queryByRole('button', {name: 'Choose iCloud folder'})).not.toBeInTheDocument();
  for (const [name, method] of Object.entries(smbApi)) if (name !== 'status') expect(method).not.toHaveBeenCalled();
  expect(icloudApi.request).toHaveBeenCalledTimes(1);
  expect(icloudApi.request).toHaveBeenCalledWith();
  fireEvent.change(selector, {target: {value: 'smb'}});
  expect(await screen.findByRole('heading', {name: 'Existing SMB library'})).toBeInTheDocument();
 });

 it.each(['smb', 'icloud'])('refreshes the shared library after an explicit %s action', async provider => {
  render(<PermissionsPage/>);
  await screen.findByText('Permissions authorized');
  fireEvent.change(screen.getByRole('combobox', {name: 'Remote storage provider'}), {target: {value: provider}});
  const button = await screen.findByRole('button', {name: provider === 'smb' ? 'Save name' : 'Pause iCloud access'});
  const previous = vi.mocked(StorageLibrarySettings).mock.calls.length;
  fireEvent.click(button);
  await waitFor(() => expect(vi.mocked(StorageLibrarySettings).mock.calls.length).toBeGreaterThan(previous));
  if (provider === 'smb') expect(smbApi.rename).toHaveBeenCalledWith('existing-smb', 'Existing SMB library');
  else expect(icloudApi.request).toHaveBeenCalledWith({action: 'enable', connectionId: 'existing-icloud', enabled: false});
 });

 it.each(['smb', 'icloud'])('refreshes the shared library when a pending %s action finishes after switching forms', async provider => {
  render(<PermissionsPage/>);
  await screen.findByText('Permissions authorized');
  const selector = screen.getByRole('combobox', {name: 'Remote storage provider'});
  fireEvent.change(selector, {target: {value: provider}});
  const button = await screen.findByRole('button', {name: provider === 'smb' ? 'Save name' : 'Pause iCloud access'});
  let finish!: () => void;
  if (provider === 'smb') vi.mocked(smbApi.rename).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(smbSnapshot); }));
  else vi.mocked(icloudApi.request).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(icloudSnapshot as never); }));
  fireEvent.click(button);
  fireEvent.change(selector, {target: {value: provider === 'smb' ? 'icloud' : 'smb'}});
  await screen.findByRole('button', {name: provider === 'smb' ? 'Pause iCloud access' : 'Save name'});
  const previous = vi.mocked(StorageLibrarySettings).mock.calls.length;
  await act(async () => { finish(); });
  expect(vi.mocked(StorageLibrarySettings).mock.calls.length).toBeGreaterThan(previous);
 });

 it.each([
  ['en', 'Remote storage provider', 'Choose remote storage'],
  ['pt-BR', 'Provedor de armazenamento remoto', 'Escolha o armazenamento remoto'],
  ['fr', 'Fournisseur de stockage distant', 'Choisir le stockage distant'],
  ['de', 'Anbieter für Remotespeicher', 'Remotespeicher auswählen'],
 ] as const)('preserves the provider choice and localized labels in %s', async (locale, label, placeholder) => {
  useLocaleStore.setState({locale});
  render(<PermissionsPage/>);
  const selector = screen.getByRole('combobox', {name: label});
  expect(within(selector).getByRole('option', {name: placeholder})).toBeInTheDocument();
  fireEvent.change(selector, {target: {value: 'smb'}});
  await waitFor(() => expect(smbApi.status).toHaveBeenCalled());
  act(() => useLocaleStore.getState().sync('en'));
  expect(await screen.findByRole('combobox', {name: 'Remote storage provider'})).toHaveValue('smb');
 });
});
