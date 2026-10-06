// Scoped to action labels; meeting content, account data, and URLs are never sent.
(function (root) {
  const normalize = value => value.trim().toLocaleLowerCase().split("(")[0].trim();
  const leave = new Set(["leave call", "leave the call", "sair da chamada", "sair da reunião", "quitter l'appel", "quitter l’appel", "quitter la réunion", "anruf verlassen", "anruf beenden", "besprechung verlassen"]);
  const microphone = new Set(["turn off microphone", "turn on microphone", "disable microphone", "enable microphone", "desativar microfone", "ativar microfone", "désactiver le micro", "activer le micro", "mikrofon ausschalten", "mikrofon einschalten"]);
  const camera = new Set(["turn off camera", "turn on camera", "desativar câmera", "ativar câmera", "désactiver la caméra", "activer la caméra", "kamera ausschalten", "kamera einschalten"]);
  const prejoin = new Set(["join now", "ask to join", "participar agora", "pedir para participar", "rejoindre maintenant", "demander à participer", "jetzt teilnehmen", "teilnahme anfragen"]);
  const rejoin = new Set(["rejoin", "join again", "return to home screen", "voltar a participar", "participar novamente", "retornar à tela inicial", "rejoindre à nouveau", "revenir à l’accueil", "erneut teilnehmen", "zur startseite zurückkehren"]);
  const intersects = (values, expected) => values.some(value => expected.has(normalize(value)));
  function evidence(labels, wasActive) {
    if (intersects(labels, prejoin)) return "unknown";
    const active = intersects(labels, leave) && intersects(labels, microphone) && intersects(labels, camera);
    if (active) return "active";
    if (wasActive && intersects(labels, rejoin)) return "inactive";
    return "unknown";
  }
  root.HeedMeetSignals = { evidence };
})(typeof globalThis !== "undefined" ? globalThis : this);
