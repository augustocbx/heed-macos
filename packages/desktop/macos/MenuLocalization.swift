import Foundation

struct MenuLocalization {
    static let locales = ["en", "pt-BR", "fr", "de"]
    static func normalize(_ locale: String?) -> String { locales.contains(locale ?? "") ? locale! : "en" }
    private static let translations: [String: [String: String]] = [
        "pt-BR": [
            "Local meeting storage": "Armazenamento local de reuniões",
            "Meeting detection could not save its state. Automation is disabled; stop the recording manually and reconfigure detection after fixing storage.": "Não foi possível salvar o estado da detecção. A automação está desativada; pare a gravação manualmente e reconfigure a detecção após corrigir o armazenamento.",
            "Meeting detection settings could not be read. Reconfigure detection before using it.": "Não foi possível ler as configurações da detecção. Reconfigure a detecção antes de usá-la.",
            "Waiting for reconnect — %@s": "Aguardando reconexão — %@s",
            "Automatically record Zoom meetings": "Gravar reuniões do Zoom automaticamente",
            "Automatically record Teams meetings": "Gravar reuniões do Teams automaticamente",
            "Automatically record Google Meet meetings": "Gravar reuniões do Google Meet automaticamente",
            "Authorize Accessibility": "Autorizar Acessibilidade",
            "Paused for this call": "Pausado para esta chamada",
            "Accessibility permission needed": "Permissão de Acessibilidade necessária",
            "Detection unavailable — use manual recording": "Detecção indisponível — use a gravação manual",
            "Not checked": "Não verificado",
            "Could not save meeting detection settings.": "Não foi possível salvar as configurações de detecção de reuniões.",
            "Automatic recording is waiting for capture permissions and a ready transcription model.": "A gravação automática aguarda permissões de captura e um modelo de transcrição pronto.",
            "Finish the active meeting before quitting Heed.": "Finalize a reunião ativa antes de sair do Heed.",
            "Could not check recording status. Try again before quitting.": "Não foi possível verificar a gravação. Tente novamente antes de sair.",
            "Preparing services…": "Preparando serviços…",
            "Start recording": "Iniciar gravação",
            "Stop recording": "Parar gravação",
            "Open interface": "Abrir interface",
            "Settings and permissions…": "Configurações e permissões…",
            "Automatically record Slack meetings": "Gravar reuniões do Slack automaticamente",
            "Allow Slack log access…": "Autorizar acesso aos logs do Slack…",
            "Quit menu app": "Sair do aplicativo da barra",
            "Interface language": "Idioma da interface",
            "Recording": "Gravando",
            "Processing meeting…": "Processando reunião…",
            "Waiting for the interface…": "Aguardando a interface…",
            "Ready to record": "Pronto para gravar",
            "Service unavailable — open the interface": "Serviço indisponível — abra a interface",
            "Heed recording": "Heed gravando",
            "disabled": "desativado",
            "closed": "fechado",
            "unavailable": "indisponível",
            "meeting detected": "reunião detectada",
            "waiting for the next meeting": "aguardando a próxima reunião",
            "Allow microphone access for Heed in System Settings.": "Autorize o acesso ao microfone para o Heed nos Ajustes do Sistema.",
            "Unknown authorization request.": "Solicitação de autorização desconhecida.",
            "The Slack log authorization dialog is already open.": "A janela de autorização dos logs do Slack já está aberta.",
            "Allow Slack meeting detection": "Autorizar detecção de reuniões do Slack",
            "Select the Slack logs folder. Heed only reads logs to detect when a meeting starts or ends.": "Selecione a pasta de logs do Slack. O Heed só lê os logs para detectar quando uma reunião começa ou termina.",
            "Allow log access": "Autorizar acesso aos logs",
            "Slack log authorization was canceled.": "A autorização dos logs do Slack foi cancelada.",
            "Select the exact Slack logs folder; access to other folders will not be granted.": "Selecione a pasta exata de logs do Slack; o acesso a outras pastas não será autorizado.",
            "The saved authorization does not match the Slack log folder.": "A autorização salva não corresponde à pasta de logs do Slack.",
            "Could not save the interface language. Try again.": "Não foi possível salvar o idioma da interface. Tente novamente.",
            "Communication failed (HTTP %@)": "Falha na comunicação (HTTP %@)",
            "Could not restore Slack log authorization (code %@).": "Não foi possível restaurar a autorização dos logs do Slack (código %@).",
            "Access is allowed for this launch; could not save the authorization (code %@).": "O acesso está autorizado nesta execução; não foi possível salvar a autorização (código %@).",
            "Recording controller disconnected. Open the interface and check the capture before retrying.": "O controle da gravação foi desconectado. Abra a interface e verifique a captura antes de tentar novamente.",
            "Recording command expired. Open the interface and try again.": "O comando de gravação expirou. Abra a interface e tente novamente.",
            "Heed is already recording": "O Heed já está gravando",
            "Heed is not recording": "O Heed não está gravando",
            "Heed is still processing the previous recording": "O Heed ainda está processando a gravação anterior",
            "A recording command is already pending": "Já há um comando de gravação pendente"
        ],
        "fr": [
            "Local meeting storage": "Stockage local des réunions",
            "Meeting detection could not save its state. Automation is disabled; stop the recording manually and reconfigure detection after fixing storage.": "Impossible d’enregistrer l’état de détection. L’automatisation est désactivée ; arrêtez manuellement l’enregistrement et reconfigurez la détection après avoir corrigé le stockage.",
            "Meeting detection settings could not be read. Reconfigure detection before using it.": "Impossible de lire les paramètres de détection. Reconfigurez la détection avant de l’utiliser.",
            "Waiting for reconnect — %@s": "En attente de reconnexion — %@s",
            "Automatically record Zoom meetings": "Enregistrer automatiquement les réunions Zoom",
            "Automatically record Teams meetings": "Enregistrer automatiquement les réunions Teams",
            "Automatically record Google Meet meetings": "Enregistrer automatiquement les réunions Google Meet",
            "Authorize Accessibility": "Autoriser l’accessibilité",
            "Paused for this call": "En pause pour cet appel",
            "Accessibility permission needed": "Autorisation d’accessibilité nécessaire",
            "Detection unavailable — use manual recording": "Détection indisponible — utilisez l’enregistrement manuel",
            "Not checked": "Non vérifié",
            "Could not save meeting detection settings.": "Impossible d’enregistrer les paramètres de détection des réunions.",
            "Automatic recording is waiting for capture permissions and a ready transcription model.": "L’enregistrement automatique attend les autorisations de capture et un modèle de transcription prêt.",
            "Finish the active meeting before quitting Heed.": "Terminez la réunion active avant de quitter Heed.",
            "Could not check recording status. Try again before quitting.": "Impossible de vérifier l’enregistrement. Réessayez avant de quitter.",
            "Preparing services…": "Préparation des services…",
            "Start recording": "Démarrer l’enregistrement",
            "Stop recording": "Arrêter l’enregistrement",
            "Open interface": "Ouvrir l’interface",
            "Settings and permissions…": "Paramètres et autorisations…",
            "Automatically record Slack meetings": "Enregistrer automatiquement les réunions Slack",
            "Allow Slack log access…": "Autoriser l’accès aux journaux Slack…",
            "Quit menu app": "Quitter l’application de la barre",
            "Interface language": "Langue de l’interface",
            "Recording": "Enregistrement",
            "Processing meeting…": "Traitement de la réunion…",
            "Waiting for the interface…": "En attente de l’interface…",
            "Ready to record": "Prêt à enregistrer",
            "Service unavailable — open the interface": "Service indisponible — ouvrez l’interface",
            "Heed recording": "Heed enregistre",
            "disabled": "désactivé",
            "closed": "fermé",
            "unavailable": "indisponible",
            "meeting detected": "réunion détectée",
            "waiting for the next meeting": "en attente de la prochaine réunion",
            "Allow microphone access for Heed in System Settings.": "Autorisez l’accès au microphone pour Heed dans les Réglages Système.",
            "Unknown authorization request.": "Demande d’autorisation inconnue.",
            "The Slack log authorization dialog is already open.": "La fenêtre d’autorisation des journaux Slack est déjà ouverte.",
            "Allow Slack meeting detection": "Autoriser la détection des réunions Slack",
            "Select the Slack logs folder. Heed only reads logs to detect when a meeting starts or ends.": "Sélectionnez le dossier des journaux Slack. Heed les lit uniquement pour détecter le début ou la fin d’une réunion.",
            "Allow log access": "Autoriser l’accès aux journaux",
            "Slack log authorization was canceled.": "L’autorisation des journaux Slack a été annulée.",
            "Select the exact Slack logs folder; access to other folders will not be granted.": "Sélectionnez le dossier exact des journaux Slack ; l’accès aux autres dossiers ne sera pas autorisé.",
            "The saved authorization does not match the Slack log folder.": "L’autorisation enregistrée ne correspond pas au dossier des journaux Slack.",
            "Could not save the interface language. Try again.": "Impossible d’enregistrer la langue de l’interface. Réessayez.",
            "Communication failed (HTTP %@)": "Échec de la communication (HTTP %@)",
            "Could not restore Slack log authorization (code %@).": "Impossible de restaurer l’autorisation des journaux Slack (code %@).",
            "Access is allowed for this launch; could not save the authorization (code %@).": "L’accès est autorisé pour cette exécution ; impossible d’enregistrer l’autorisation (code %@).",
            "Recording controller disconnected. Open the interface and check the capture before retrying.": "Le contrôleur d’enregistrement est déconnecté. Ouvrez l’interface et vérifiez la capture avant de réessayer.",
            "Recording command expired. Open the interface and try again.": "La commande d’enregistrement a expiré. Ouvrez l’interface et réessayez.",
            "Heed is already recording": "Heed enregistre déjà",
            "Heed is not recording": "Heed n’enregistre pas",
            "Heed is still processing the previous recording": "Heed traite encore l’enregistrement précédent",
            "A recording command is already pending": "Une commande d’enregistrement est déjà en attente"
        ],
        "de": [
            "Local meeting storage": "Lokaler Besprechungsspeicher",
            "Meeting detection could not save its state. Automation is disabled; stop the recording manually and reconfigure detection after fixing storage.": "Der Erkennungsstatus konnte nicht gespeichert werden. Die Automatisierung ist deaktiviert; beenden Sie die Aufnahme manuell und konfigurieren Sie die Erkennung nach Beheben des Speicherproblems erneut.",
            "Meeting detection settings could not be read. Reconfigure detection before using it.": "Die Erkennungseinstellungen konnten nicht gelesen werden. Konfigurieren Sie die Erkennung vor der Nutzung erneut.",
            "Waiting for reconnect — %@s": "Warten auf Wiederverbindung — %@s",
            "Automatically record Zoom meetings": "Zoom-Besprechungen automatisch aufnehmen",
            "Automatically record Teams meetings": "Teams-Besprechungen automatisch aufnehmen",
            "Automatically record Google Meet meetings": "Google-Meet-Besprechungen automatisch aufnehmen",
            "Authorize Accessibility": "Bedienungshilfen erlauben",
            "Paused for this call": "Für diesen Anruf pausiert",
            "Accessibility permission needed": "Berechtigung für Bedienungshilfen erforderlich",
            "Detection unavailable — use manual recording": "Erkennung nicht verfügbar — manuell aufnehmen",
            "Not checked": "Nicht geprüft",
            "Could not save meeting detection settings.": "Die Einstellungen der Besprechungserkennung konnten nicht gespeichert werden.",
            "Automatic recording is waiting for capture permissions and a ready transcription model.": "Die automatische Aufnahme wartet auf Aufnahmeberechtigungen und ein bereites Transkriptionsmodell.",
            "Finish the active meeting before quitting Heed.": "Beenden Sie die aktive Besprechung, bevor Sie Heed schließen.",
            "Could not check recording status. Try again before quitting.": "Der Aufnahmestatus konnte nicht geprüft werden. Versuchen Sie es vor dem Beenden erneut.",
            "Preparing services…": "Dienste werden vorbereitet…",
            "Start recording": "Aufnahme starten",
            "Stop recording": "Aufnahme beenden",
            "Open interface": "Oberfläche öffnen",
            "Settings and permissions…": "Einstellungen und Berechtigungen…",
            "Automatically record Slack meetings": "Slack-Besprechungen automatisch aufnehmen",
            "Allow Slack log access…": "Zugriff auf Slack-Protokolle erlauben…",
            "Quit menu app": "Menüleisten-App beenden",
            "Interface language": "Sprache der Oberfläche",
            "Recording": "Aufnahme läuft",
            "Processing meeting…": "Besprechung wird verarbeitet…",
            "Waiting for the interface…": "Warten auf die Oberfläche…",
            "Ready to record": "Bereit zur Aufnahme",
            "Service unavailable — open the interface": "Dienst nicht verfügbar — Oberfläche öffnen",
            "Heed recording": "Heed nimmt auf",
            "disabled": "deaktiviert",
            "closed": "geschlossen",
            "unavailable": "nicht verfügbar",
            "meeting detected": "Besprechung erkannt",
            "waiting for the next meeting": "Warten auf die nächste Besprechung",
            "Allow microphone access for Heed in System Settings.": "Erlauben Sie Heed den Mikrofonzugriff in den Systemeinstellungen.",
            "Unknown authorization request.": "Unbekannte Berechtigungsanfrage.",
            "The Slack log authorization dialog is already open.": "Das Fenster zur Autorisierung der Slack-Protokolle ist bereits geöffnet.",
            "Allow Slack meeting detection": "Erkennung von Slack-Besprechungen erlauben",
            "Select the Slack logs folder. Heed only reads logs to detect when a meeting starts or ends.": "Wählen Sie den Slack-Protokollordner. Heed liest die Protokolle nur, um Beginn und Ende einer Besprechung zu erkennen.",
            "Allow log access": "Protokollzugriff erlauben",
            "Slack log authorization was canceled.": "Die Autorisierung der Slack-Protokolle wurde abgebrochen.",
            "Select the exact Slack logs folder; access to other folders will not be granted.": "Wählen Sie den genauen Slack-Protokollordner; Zugriff auf andere Ordner wird nicht gewährt.",
            "The saved authorization does not match the Slack log folder.": "Die gespeicherte Autorisierung entspricht nicht dem Slack-Protokollordner.",
            "Could not save the interface language. Try again.": "Die Sprache der Oberfläche konnte nicht gespeichert werden. Versuchen Sie es erneut.",
            "Communication failed (HTTP %@)": "Kommunikation fehlgeschlagen (HTTP %@)",
            "Could not restore Slack log authorization (code %@).": "Die Autorisierung der Slack-Protokolle konnte nicht wiederhergestellt werden (Code %@).",
            "Access is allowed for this launch; could not save the authorization (code %@).": "Der Zugriff ist für diesen Start erlaubt; die Autorisierung konnte nicht gespeichert werden (Code %@).",
            "Recording controller disconnected. Open the interface and check the capture before retrying.": "Die Aufnahmesteuerung wurde getrennt. Öffnen Sie die Oberfläche und prüfen Sie die Aufnahme, bevor Sie es erneut versuchen.",
            "Recording command expired. Open the interface and try again.": "Der Aufnahmebefehl ist abgelaufen. Öffnen Sie die Oberfläche und versuchen Sie es erneut.",
            "Heed is already recording": "Heed nimmt bereits auf",
            "Heed is not recording": "Heed nimmt nicht auf",
            "Heed is still processing the previous recording": "Heed verarbeitet noch die vorherige Aufnahme",
            "A recording command is already pending": "Ein Aufnahmebefehl wartet bereits auf Ausführung"
        ]
    ]
    static func text(_ key: String, locale: String) -> String { translations[normalize(locale)]?[key] ?? key }
    static func format(_ key: String, locale: String, value: String) -> String {
        String(format: text(key, locale: locale), value)
    }
    static func message(_ message: String, locale: String) -> String {
        if message.hasPrefix("Communication failed (HTTP "),
           let range = message.range(of: #"(?<=HTTP )[0-9]+"#, options: .regularExpression) {
            return format("Communication failed (HTTP %@)", locale: locale, value: String(message[range]))
        }
        for prefix in ["Could not restore Slack log authorization", "Access is allowed for this launch; could not save the authorization"] {
            if message.hasPrefix(prefix), let range = message.range(of: #"(?<=code )-?[0-9]+"#, options: .regularExpression) {
                return format(prefix + " (code %@).", locale: locale, value: String(message[range]))
            }
        }
        return text(message, locale: locale)
    }
    static func selfTestCoverage() {
        let keys = Set(translations["pt-BR"]!.keys)
        for locale in ["fr", "de"] { precondition(Set(translations[locale]!.keys) == keys) }
    }
}

func menuLocalizationSelfTests() {
    MenuLocalization.selfTestCoverage()
    precondition(MenuLocalization.text("Start recording", locale: "fr") == "Démarrer l’enregistrement")
    precondition(MenuLocalization.text("Stop recording", locale: "pt-BR") == "Parar gravação")
    precondition(MenuLocalization.text("Ready to record", locale: "de") == "Bereit zur Aufnahme")
    precondition(MenuLocalization.text("Start recording", locale: "en") == "Start recording")
    precondition(MenuLocalization.normalize("es") == "en")
    precondition(MenuLocalization.normalize(nil) == "en")
    precondition(MenuLocalization.message("Communication failed (HTTP 500)", locale: "de") == "Kommunikation fehlgeschlagen (HTTP 500)")
    precondition(MenuLocalization.message("Could not restore Slack log authorization (code -1).", locale: "pt-BR").contains("código -1"))
    precondition(MenuLocalization.text("Unknown technical detail", locale: "fr") == "Unknown technical detail")
}
