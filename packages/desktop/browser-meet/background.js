const host = "local.heed.meet";
let port;
let queue = Promise.resolve();
const connect = () => {
  if (port) return port;
  port = chrome.runtime.connectNative(host);
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; port = undefined; chrome.action.setBadgeText({ text: "!" }); });
  port.onMessage.addListener(message => { chrome.action.setBadgeText({ text: message.ok ? "" : "!" }); });
  return port;
};
async function nextSequence(detectorId, sources) {
  const { sequences = {} } = await chrome.storage.local.get("sequences");
  const previous = sequences[detectorId]?.sequence;
  const sequence = (Number.isSafeInteger(previous) && previous >= 0 ? previous : 0) + 1;
  sequences[detectorId] = { sequence, updatedAt: Date.now() };
  const active = new Set(Object.values(sources).map(source => source.detectorId));
  const keys = Object.keys(sequences).sort((a,b) => sequences[a].updatedAt - sequences[b].updatedAt);
  for (const key of keys) {
    if (Object.keys(sequences).length <= 256) break;
    if (!active.has(key) && key !== detectorId) delete sequences[key];
  }
  // Persist before submitting: browser restart must never reset an observed sequence.
  await chrome.storage.local.set({ sequences });
  return sequence;
}
async function forward(tabId, observation, documentId) {
  const { sources = {} } = await chrome.storage.session.get("sources");
  const previous = sources[tabId];
  if (previous && previous.documentId !== documentId && observation.detectorId !== previous.detectorId) {
    // New documents do not prove the previous call ended (reload/network failure).
    const sequence = await nextSequence(previous.detectorId,sources);
    connect().postMessage({ ...previous.report, sequence, state: "unknown", capability: "degraded" });
  }
  const sequence = await nextSequence(observation.detectorId,sources);
  const report = { app: "meet", ...observation, sequence };
  sources[tabId] = { detectorId: observation.detectorId, sequence, report, documentId };
  await chrome.storage.session.set({ sources });
  connect().postMessage(report);
}
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.frameId !== 0 || !sender.tab || !sender.url?.startsWith("https://meet.google.com/") || message?.type !== "heed-meet-state") return;
  const { detectorId, callId, state, capability } = message;
  if (!/^browser:[a-zA-Z0-9_-]{1,100}$/.test(detectorId) || (callId !== null && !/^[a-zA-Z0-9_-]{1,100}$/.test(callId)) || !["active", "inactive", "unknown"].includes(state) || !["ready", "degraded"].includes(capability)) return;
  queue = queue.then(() => forward(sender.tab.id, { detectorId, callId, state, capability }, sender.documentId)).catch(() => chrome.action.setBadgeText({ text: "!" }));
});
chrome.tabs.onRemoved.addListener(tabId => {
  queue = queue.then(async () => {
    const { sources = {} } = await chrome.storage.session.get("sources");
    const previous = sources[tabId]; if (!previous) return;
    const sequence = await nextSequence(previous.detectorId,sources);
    connect().postMessage({ ...previous.report, sequence, state: "inactive", callId: null, capability: "ready" });
    delete sources[tabId]; await chrome.storage.session.set({ sources });
  }).catch(() => chrome.action.setBadgeText({ text: "!" }));
});
