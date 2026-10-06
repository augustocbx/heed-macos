import type {Locale} from './locale';
export const SERVICE_TRANSLATIONS:Record<string,Partial<Record<Locale,string>>>={
 "Heed API": {
  "pt-BR": "API do Heed",
  "fr": "API Heed",
  "de": "Heed-API"
 },
 "Heed interface": {
  "pt-BR": "Interface do Heed",
  "fr": "Interface Heed",
  "de": "Heed-Oberfläche"
 },
 "Transcription engine": {
  "pt-BR": "Motor de transcrição",
  "fr": "Moteur de transcription",
  "de": "Transkriptionsengine"
 },
 "Another application is using {service} port {port}.": {
  "pt-BR": "Outro aplicativo está usando a porta {port} de {service}.",
  "fr": "Une autre application utilise le port {port} de {service}.",
  "de": "Eine andere Anwendung verwendet Port {port} für {service}."
 },
 "{service} is stopped on port {port}.": {
  "pt-BR": "{service} está parado na porta {port}.",
  "fr": "{service} est arrêté sur le port {port}.",
  "de": "{service} ist auf Port {port} angehalten."
 },
 "{service} is starting on port {port}.": {
  "pt-BR": "{service} está iniciando na porta {port}.",
  "fr": "{service} démarre sur le port {port}.",
  "de": "{service} startet auf Port {port}."
 },
 "{service} is not healthy on port {port}.": {
  "pt-BR": "{service} não está funcionando corretamente na porta {port}.",
  "fr": "{service} ne fonctionne pas correctement sur le port {port}.",
  "de": "{service} funktioniert auf Port {port} nicht ordnungsgemäß."
 },
 "Could not diagnose {service} on port {port}.": {
  "pt-BR": "Não foi possível diagnosticar {service} na porta {port}.",
  "fr": "Impossible de diagnostiquer {service} sur le port {port}.",
  "de": "{service} auf Port {port} konnte nicht diagnostiziert werden."
 },
 "Application: {application}": {
  "pt-BR": "Aplicativo: {application}",
  "fr": "Application : {application}",
  "de": "Anwendung: {application}"
 },
 "Heed preserved the other application. Stop it yourself, or choose a free allowed Heed port and restart Heed.": {
  "pt-BR": "O Heed preservou o outro aplicativo. Pare-o manualmente ou escolha uma porta permitida livre para o Heed e reinicie o Heed.",
  "fr": "Heed a préservé l’autre application. Arrêtez-la vous-même ou choisissez un port autorisé libre pour Heed et redémarrez Heed.",
  "de": "Heed hat die andere Anwendung unverändert gelassen. Beenden Sie sie selbst oder wählen Sie einen freien zulässigen Heed-Port und starten Sie Heed neu."
 },
 "Retry Heed startup after checking the service and its configured port.": {
  "pt-BR": "Tente iniciar o Heed novamente após verificar o serviço e sua porta configurada.",
  "fr": "Réessayez le démarrage de Heed après avoir vérifié le service et son port configuré.",
  "de": "Prüfen Sie den Dienst und seinen konfigurierten Port und versuchen Sie anschließend erneut, Heed zu starten."
 },
 "Change the service port in service-ports.json, or use its HEED_API_PORT, HEED_UI_PORT or HEED_TRANSCRIPTION_PORT startup setting. Ports 3000–3999, 5000–5999, 7000–7999 and 8000–8999 are unavailable.": {
  "pt-BR": "Altere a porta do serviço em service-ports.json ou use sua configuração de inicialização HEED_API_PORT, HEED_UI_PORT ou HEED_TRANSCRIPTION_PORT. As portas 3000–3999, 5000–5999, 7000–7999 e 8000–8999 não estão disponíveis.",
  "fr": "Modifiez le port du service dans service-ports.json ou utilisez son paramètre de démarrage HEED_API_PORT, HEED_UI_PORT ou HEED_TRANSCRIPTION_PORT. Les ports 3000–3999, 5000–5999, 7000–7999 et 8000–8999 sont indisponibles.",
  "de": "Ändern Sie den Dienst-Port in service-ports.json oder verwenden Sie seine Starteinstellung HEED_API_PORT, HEED_UI_PORT oder HEED_TRANSCRIPTION_PORT. Die Ports 3000–3999, 5000–5999, 7000–7999 und 8000–8999 sind nicht verfügbar."
 },
 "Check again": {
  "pt-BR": "Verificar novamente",
  "fr": "Vérifier à nouveau",
  "de": "Erneut prüfen"
 },
 "Installed app and LaunchAgent port settings must match. If they still use the old ports, rerun the installer while idle with matching settings.": {
  "pt-BR": "As portas do aplicativo instalado e do LaunchAgent devem coincidir. Se ainda usarem as portas antigas, execute novamente o instalador sem reunião ativa com configurações correspondentes.",
  "fr": "Les ports de l’application installée et du LaunchAgent doivent correspondre. S’ils utilisent encore les anciens ports, réexécutez l’installateur sans réunion active avec les paramètres correspondants.",
  "de": "Die Port-Einstellungen der installierten App und des LaunchAgent müssen übereinstimmen. Falls sie noch die alten Ports verwenden, führen Sie das Installationsprogramm ohne aktive Besprechung mit übereinstimmenden Einstellungen erneut aus."
 },
 "Could not diagnose Heed services.": {
  "pt-BR": "Não foi possível diagnosticar os serviços do Heed.",
  "fr": "Impossible de diagnostiquer les services Heed.",
  "de": "Die Heed-Dienste konnten nicht diagnostiziert werden."
 },
 "Service checks are unavailable. Heed has not verified service status. Check again before troubleshooting.": {
  "pt-BR": "As verificações dos serviços estão indisponíveis. O Heed não verificou o estado dos serviços. Verifique novamente antes de tentar corrigir problemas.",
  "fr": "Les vérifications des services sont indisponibles. Heed n’a pas vérifié leur état. Vérifiez à nouveau avant le dépannage.",
  "de": "Die Dienstprüfungen sind nicht verfügbar. Heed hat den Dienststatus nicht überprüft. Prüfen Sie erneut, bevor Sie Probleme beheben."
 },
 "No verified transcription profile.": {
  "pt-BR": "Nenhum perfil de transcrição verificado.",
  "fr": "Aucun profil de transcription vérifié.",
  "de": "Kein überprüftes Transkriptionsprofil."
 },
 "No verified diarization profile.": {
  "pt-BR": "Nenhum perfil de identificação de falantes verificado.",
  "fr": "Aucun profil de diarisation vérifié.",
  "de": "Kein überprüftes Sprechererkennungsprofil."
 }
};
