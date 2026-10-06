import { expect, test } from "bun:test";
import "./signals.js";
const signals = (globalThis as any).HeedMeetSignals;
test("Meet requires leave, microphone and camera controls in four UI locales", () => {
  for (const labels of [["Leave call", "Turn off microphone (ctrl + d)", "Turn off camera"], ["Sair da chamada", "Desativar microfone", "Desativar câmera"], ["Quitter l’appel", "Désactiver le micro", "Désactiver la caméra"], ["Anruf verlassen", "Mikrofon ausschalten", "Kamera ausschalten"]]) expect(signals.evidence(labels, false)).toBe("active");
});
test("prejoin, unsupported controls, mute/silence and rejoin before a call remain unknown", () => {
  for (const labels of [[], ["Join now", "Turn off microphone", "Turn off camera"], ["Leave call", "Turn off microphone"], ["Rejoin"]]) expect(signals.evidence(labels, false)).toBe("unknown");
  expect(signals.evidence(["Ask to join", "Leave call", "Turn off microphone", "Turn off camera"], false)).toBe("unknown");
  expect(signals.evidence([], true)).toBe("unknown");
  expect(signals.evidence(["Rejoin"], true)).toBe("inactive");
});
