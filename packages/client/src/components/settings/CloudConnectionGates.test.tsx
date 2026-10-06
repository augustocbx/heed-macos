import {render,screen,cleanup} from '@testing-library/react';
import {it,expect,beforeEach,vi} from 'vitest';
import {GoogleDriveSettings} from './GoogleDriveSettings';
import {OneDriveSettings} from './OneDriveSettings';
import {useLocaleStore} from '@/stores/locale';
const google=vi.hoisted(()=>({snapshot:vi.fn()}));
const microsoft=vi.hoisted(()=>({snapshot:vi.fn()}));
vi.mock('@/api/google-drive',()=>({googleDriveApi:google}));
vi.mock('@/api/onedrive',()=>({oneDriveApi:microsoft,oneDriveExpectation:vi.fn()}));
beforeEach(()=>{cleanup();vi.clearAllMocks();google.snapshot.mockResolvedValue({connected:false,generation:0});microsoft.snapshot.mockResolvedValue({connected:false,folderGeneration:0,authGeneration:0});});
it.each([
 ['en','Google Drive and OneDrive are disabled until public desktop OAuth application IDs are configured and real-account validation is completed. Local meetings and pending copies are preserved.'],
 ['pt-BR','O Google Drive e o OneDrive estão desativados até que os IDs públicos dos aplicativos OAuth para computador sejam configurados e a validação com contas reais seja concluída. Reuniões locais e cópias pendentes são preservadas.'],
 ['fr','Google Drive et OneDrive sont désactivés jusqu’à la configuration des identifiants publics des applications OAuth pour ordinateur et la validation avec des comptes réels. Les réunions locales et les copies en attente sont conservées.'],
 ['de','Google Drive und OneDrive sind deaktiviert, bis öffentliche Desktop-OAuth-Anwendungs-IDs konfiguriert und die Prüfung mit echten Konten abgeschlossen sind. Lokale Besprechungen und ausstehende Kopien bleiben erhalten.'],
] as const)('default-off cloud settings make no account requests in %s',async(locale,notice)=>{
 useLocaleStore.getState().sync(locale);render(<><GoogleDriveSettings/><OneDriveSettings/></>);
 expect(screen.getAllByRole('status')).toHaveLength(2);for(const node of screen.getAllByRole('status'))expect(node).toHaveTextContent(notice);
 expect(screen.queryByRole('button')).not.toBeInTheDocument();expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
 expect(google.snapshot).not.toHaveBeenCalled();expect(microsoft.snapshot).not.toHaveBeenCalled();
});
