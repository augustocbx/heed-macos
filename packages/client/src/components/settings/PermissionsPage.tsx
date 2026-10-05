import { useCallback, useEffect, useState } from 'react';
import { permissionsApi, type PermissionAction, type PermissionSnapshot } from '@/api/permissions.ts';
import styles from './PermissionsPage.module.css';

export function PermissionsPage() {
 const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null);
 const [loadError, setLoadError] = useState(false);
 const [actionError, setActionError] = useState<string | null>(null);
 const [action, setAction] = useState<PermissionAction | null>(null);
 const [notice, setNotice] = useState<string | null>(null);
 const refresh = useCallback(async () => {
  try { setSnapshot(await permissionsApi.status()); setLoadError(false); }
  catch { setLoadError(true); }
 }, []);
 useEffect(() => {
  void refresh();
  const interval = window.setInterval(() => void refresh(), 3000);
  const onFocus = () => void refresh();
  window.addEventListener('focus', onFocus);
  return () => { clearInterval(interval); window.removeEventListener('focus', onFocus); };
 }, [refresh]);
 const authorize = async (target: PermissionAction) => {
  setAction(target); setActionError(null); setNotice(null);
  try { await permissionsApi.authorize(target); setNotice('Conclua a autorização na janela do macOS. Esta tela verifica as permissões automaticamente.'); await refresh(); }
  catch { setActionError('Não foi possível abrir a autorização. Confirme que o aplicativo Heed está aberto e tente novamente.'); }
  finally { setAction(null); }
 };
 const connected = !loadError && snapshot?.controllerConnected === true;
 const permissions = connected ? snapshot?.permissions : null;
 const microphone = permissions?.microphone ?? 'unknown';
 const system = permissions?.screenCapture ?? null;
 const slack = permissions?.slackLogs ?? null;
 const slackOptional = permissions?.slackAutoRecord === false;
 const missing = microphone === 'denied' || microphone === 'restricted' || microphone === 'notDetermined' || system === false || (!slackOptional && slack === false);
 const ready = connected && microphone === 'authorized' && system === true && (slackOptional || (permissions?.slackAutoRecord === true && slack === true));
 const title = loadError ? 'Não foi possível verificar as permissões' : !snapshot ? 'Verificando permissões…' : !connected ? 'Aplicativo Heed desconectado' : missing ? 'Permissões pendentes' : ready ? 'Permissões autorizadas' : 'Verificação incompleta';
 const boolStatus = (value: boolean | null) => value === true ? 'Autorizado' : value === false ? 'Não autorizado' : 'Não verificado';
 const disabled = !connected || !!action || !!snapshot?.pending;
 const rows = [
  { id: 'microphone' as const, title: 'Microfone', description: 'Permite gravar sua voz.', status: microphone === 'authorized' ? 'Autorizado' : microphone === 'denied' ? 'Não autorizado' : microphone === 'restricted' ? 'Restrito pelo macOS' : microphone === 'notDetermined' ? 'Aguardando autorização' : 'Não verificado', allowed: microphone === 'authorized', button: microphone === 'authorized' || microphone === 'denied' || microphone === 'restricted' ? 'Abrir ajustes do microfone' : 'Autorizar microfone', help: 'Em Ajustes do Sistema → Privacidade e Segurança → Microfone, habilite o Heed.' },
  { id: 'screenCapture' as const, title: 'Áudio do sistema', description: 'Permite gravar a voz dos outros participantes, inclusive com fones de ouvido.', status: boolStatus(system), allowed: system === true, button: system === true ? 'Abrir ajustes do áudio do sistema' : 'Autorizar áudio do sistema', help: 'Em Ajustes do Sistema → Privacidade e Segurança → Gravação de Tela e Áudio do Sistema, habilite o Heed. O nome dessa opção pode variar conforme a versão do macOS.' },
  { id: 'slackLogs' as const, title: 'Detecção de reuniões do Slack', description: 'Permite detectar quando você entra em uma reunião no aplicativo Slack.', status: slackOptional ? 'Opcional — gravação automática desativada' : boolStatus(slack), allowed: slack === true, button: 'Autorizar registros do Slack', help: 'Na janela de seleção de pasta, autorize a pasta de registros do Slack indicada pelo Heed. Ative “Gravar automaticamente reuniões do Slack” no ícone da barra superior.' },
 ];
 return <section className={styles.page} aria-labelledby="settings-title">
  <header><h1 id="settings-title">Configurações</h1><p>Permissões deste Mac</p></header>
  <div className={`${styles.summary} ${ready ? styles.ready : styles.attention}`} role="status"><strong>{title}</strong><p>{!connected ? 'Abra o aplicativo Heed pelo ícone da barra superior para verificar e autorizar o acesso.' : ready ? 'As permissões necessárias estão autorizadas.' : 'Conclua as autorizações abaixo antes de iniciar uma reunião.'}</p><button onClick={() => void refresh()}>Verificar novamente</button></div>
  {(actionError || snapshot?.error) && <p className={styles.error} role="alert">{actionError || snapshot?.error}</p>}
  {notice && <p className={styles.notice} role="status">{notice}</p>}
  <div className={styles.cards}>{rows.map(row => <article key={row.id} className={styles.card} aria-labelledby={`permission-${row.id}`}>
   <div className={styles.cardHeading}><h2 id={`permission-${row.id}`}>{row.title}</h2><span className={row.allowed ? styles.authorized : styles.pending}>{row.status}</span></div>
   <p>{row.description}</p>
   {(!row.allowed || row.id !== 'slackLogs') && <><p className={styles.help}>{row.help}</p><button disabled={disabled} onClick={() => void authorize(row.id)}>{action === row.id ? 'Abrindo autorização…' : row.button}</button></>}
  </article>)}</div>
  <aside className={styles.tip}><strong>Já autorizou, mas a gravação continua falhando?</strong><p>Após uma atualização, o macOS pode pedir uma nova autorização. Nos Ajustes, desative e ative novamente o Heed na permissão indicada. Se o macOS pedir, escolha “Encerrar e Reabrir”. Volte a esta tela e confirme o status antes de testar.</p><p>Mantenha a interface do Heed aberta durante a gravação automática.</p></aside>
 </section>;
}
