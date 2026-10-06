(() => {
  let identity;
  try {
    identity = JSON.parse(sessionStorage.getItem("heed.meet.detector") || "null");
    if (!identity || typeof identity.id !== "string") identity = { id: crypto.randomUUID(), call: crypto.randomUUID(), active: false };
  } catch { identity = { id: crypto.randomUUID(), call: crypto.randomUUID(), active: false }; }
  let inactiveSince = null;
  const save = () => { try { sessionStorage.setItem("heed.meet.detector", JSON.stringify(identity)); } catch { /* A privacy setting can disable storage; this document still has an identity. */ } };
  const report = () => {
    // Top-level, visible button labels only. Background tabs still expose their
    // own controls; foreground focus and audio energy are not call signals.
    const controls = Array.from(document.querySelectorAll('button, [role="button"]')).filter(element => !element.closest('[hidden], [aria-hidden="true"]') && element.getClientRects().length > 0);
    const labels = controls.slice(0, 1000).map(element => element.getAttribute("aria-label") || element.textContent || "").filter(label => label.length <= 120);
    const state = globalThis.HeedMeetSignals.evidence(labels, identity.active || identity.hadCall);
    if (state === "active") {
      inactiveSince = null;
      if (!identity.active) { identity.call = crypto.randomUUID(); identity.active = true; identity.hadCall = true; }
    } else if (state === "inactive") {
      inactiveSince ??= Date.now();
      if (Date.now() - inactiveSince >= 5000) identity.active = false;
    } else { inactiveSince = null; }
    save();
    chrome.runtime.sendMessage({ type: "heed-meet-state", detectorId: `browser:${identity.id}`, callId: state === "inactive" ? null : identity.call, state, capability: state === "unknown" ? "degraded" : "ready" }).catch(() => {});
  };
  report(); setInterval(report, 2000);
})();
