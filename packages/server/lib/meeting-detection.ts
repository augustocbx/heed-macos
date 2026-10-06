import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteJson } from "./atomic-json";

export const meetingApps = ["slack", "zoom", "teams", "meet"] as const;
export type MeetingApp = typeof meetingApps[number];
export type MeetingReport = { app: MeetingApp; detectorId: string; sequence: number; state: "active" | "inactive" | "unknown"; callId: string | null; capability: "ready" | "permission-required" | "unsupported" | "degraded" };
type RecordingState = { state: string; meetingId: string | null; path?: string | null; maintenance?: boolean };
type RecordingAdapter = { snapshot(): RecordingState; start(requestId: string, mode: "both"): Promise<RecordingState>; stop(requestId: string, meetingId: string): Promise<RecordingState> };
type Source = MeetingReport & { receivedAt: number; changedAt: number; joinedAt: number | null; endedAt: number | null };
type Journal = { version: 1; enabled: Record<MeetingApp, boolean>; ownerMeetingId: string | null; ownerCalls: string[]; suppressed: string[] };
const defaultSettings = () => ({ slack: true, zoom: false, teams: false, meet: false });
const keyOf = (s: Pick<MeetingReport, "detectorId" | "callId">) => `${s.detectorId}/${s.callId}`;
const captureStates = new Set(["starting", "recording"]);
const safeIdentifier = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9:_-]{1,120}$/.test(v);

export function parseMeetingReport(value: unknown): MeetingReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid meeting observation.");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["app", "detectorId", "sequence", "state", "callId", "capability"].includes(k)) || !meetingApps.includes(v.app as MeetingApp)
    || !safeIdentifier(v.detectorId) || !Number.isSafeInteger(v.sequence) || Number(v.sequence) < 0
    || !["active", "inactive", "unknown"].includes(String(v.state)) || !["ready", "permission-required", "unsupported", "degraded"].includes(String(v.capability))
    || (v.callId !== null && !safeIdentifier(v.callId)) || (v.state === "active" && (v.callId === null || v.capability !== "ready"))
    || (v.state === "inactive" && v.callId !== null) || (v.state !== "unknown" && v.capability !== "ready")) throw new Error("Invalid meeting observation.");
  const prefix = v.app === "meet" ? "browser:" : `native:${v.app}`;
  if (v.app === "meet" ? !String(v.detectorId).startsWith(prefix) : v.detectorId !== prefix) throw new Error("Unsupported meeting detector.");
  return v as MeetingReport;
}

/** Serial backend arbitration. Unknown/stale evidence never proves that a call ended. */
export class MeetingDetectionController {
  private readonly now: () => number;
  private readonly recording: RecordingAdapter;
  private readonly journalPath?: string;
  private readonly isReady: () => boolean;
  private readonly write: typeof atomicWriteJson;
  private automationBlocked = false;
  private retired = new Map<string, number>();
  private sources = new Map<string, Source>();
  private confirmedEnds = new Map<string, number>();
  private journal: Journal = { version: 1, enabled: defaultSettings(), ownerMeetingId: null, ownerCalls: [], suppressed: [] };
  private busy = false;
  private manualRevision = 0;
  private attempts = new Map<string, number>();
  private retryAt = 0;
  private error: string | null = null;

  constructor(options: { recording: RecordingAdapter; now?: () => number; journalPath?: string; isReady?: () => boolean; write?: typeof atomicWriteJson }) {
    this.recording = options.recording; this.now = options.now ?? Date.now; this.journalPath = options.journalPath; this.isReady = options.isReady ?? (() => true); this.write = options.write ?? atomicWriteJson;
    if (this.journalPath && existsSync(this.journalPath)) {
      try {
        const v = JSON.parse(readFileSync(this.journalPath, "utf8"));
        if (v.version !== 1 || typeof v.enabled !== "object" || meetingApps.some(a => typeof v.enabled[a] !== "boolean")
          || (v.ownerMeetingId !== null && !safeIdentifier(v.ownerMeetingId)) || !Array.isArray(v.ownerCalls) || !Array.isArray(v.suppressed)
          || [...v.ownerCalls, ...v.suppressed].some(k => typeof k !== "string" || k.length > 250) || v.suppressed.length > 512) throw new Error();
        this.journal = v;
      } catch { this.journal.enabled = { slack: false, zoom: false, teams: false, meet: false }; this.error = "Meeting detection settings could not be read. Reconfigure detection before using it."; }
    }
    // A restarted recording coordinator retains audio as failed; never silently resume it.
    this.recordingChanged();
  }

  private transact(mutate: () => void) {
    const previous = this.journal;
    this.journal = structuredClone(previous);
    try {
      mutate();
      if (this.journalPath) { mkdirSync(dirname(this.journalPath), {recursive:true,mode:0o700}); this.write(this.journalPath,this.journal); }
    } catch (e) {
      this.journal = previous; this.automationBlocked = true;
      this.error = "Meeting detection could not save its state. Automation is disabled; stop the recording manually and reconfigure detection after fixing storage.";
      throw e;
    }
  }
  private suppress(keys: string[]) {
    this.journal.suppressed = [...new Set([...this.journal.suppressed, ...keys])].slice(-512);
  }
  private activeKeys() { return [...this.sources.values()].filter(s => s.callId !== null && s.endedAt === null).map(keyOf); }

  report(report: MeetingReport) {
    const r = parseMeetingReport(report), previous = this.sources.get(r.detectorId), now = this.now();
    if (r.sequence <= (previous?.sequence ?? this.retired.get(r.detectorId) ?? -1)) return false;
    if (!previous && this.sources.size >= 128) throw new Error("Too many meeting detector sources.");
    // Positive inactive evidence continues to refer to the previous call for end debounce.
    const callId = r.state === "inactive" ? previous?.callId ?? null : r.callId ?? previous?.callId ?? null;
    const sameCall = previous?.callId === callId;
    if (previous?.callId && !sameCall) {
      if (previous.state === "inactive" && previous.endedAt !== null && now - previous.endedAt >= 5000) this.confirmedEnds.set(keyOf(previous), previous.endedAt);
      // Call identity may change only after positive inactive evidence or a fresh page/session.
      if (!this.confirmedEnds.has(keyOf(previous)) && (previous.state !== "inactive" || previous.endedAt === null || now - previous.endedAt < 5000)) throw new Error("Confirm the previous call ended before replacing it.");
    }
    const source: Source = { ...r, callId, receivedAt: now, changedAt: sameCall && previous?.state === r.state ? previous.changedAt : now,
      joinedAt: r.state === "active" && r.capability === "ready" ? (sameCall && previous?.state === "active" ? previous.joinedAt : now) : null,
      endedAt: r.state === "inactive" ? (sameCall && previous?.state === "inactive" ? previous.endedAt : now) : null };
    if (r.state !== "inactive" && callId) this.confirmedEnds.delete(keyOf(source));
    this.sources.set(r.detectorId, source);
    this.recordingChanged();
    return true;
  }

  configure(patch: Partial<Record<MeetingApp, boolean>>) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.entries(patch).some(([a,v]) => !meetingApps.includes(a as MeetingApp) || typeof v !== "boolean")) throw new Error("Invalid meeting detection settings.");
    this.transact(() => {
      if (this.automationBlocked) { this.suppress([...this.journal.ownerCalls,...this.activeKeys()]); this.journal.ownerMeetingId = null; this.journal.ownerCalls = []; }
      for (const app of meetingApps) {
        if (patch[app] === false && this.journal.enabled[app]) {
          const disabled = [...this.sources.values()].filter(s => s.app === app).map(keyOf);
          this.suppress(disabled);
          if (disabled.some(k => this.journal.ownerCalls.includes(k))) { this.journal.ownerMeetingId = null; this.journal.ownerCalls = []; }
        }
      }
      this.journal.enabled = { ...this.journal.enabled, ...patch };
    });
    for (const s of this.sources.values()) if (patch[s.app] !== undefined) s.joinedAt = s.state === "active" ? this.now() : null;
    this.automationBlocked = false; this.error = null; return this.status();
  }

  manualOverride() {
    this.manualRevision++;
    this.transact(() => {
      this.suppress([...this.journal.ownerCalls,...this.activeKeys()]);
      this.journal.ownerMeetingId = null; this.journal.ownerCalls = [];
    });
  }

  recordingChanged() {
    if (this.busy || this.automationBlocked) return;
    const snapshot = this.recording.snapshot();
    const release = this.journal.ownerMeetingId && (snapshot.meetingId !== this.journal.ownerMeetingId || !captureStates.has(snapshot.state));
    const suppress = (captureStates.has(snapshot.state) || (snapshot.state === "failed" && !!snapshot.path)) && !this.journal.ownerMeetingId && this.activeKeys().some(k => !this.journal.suppressed.includes(k));
    if (release || suppress) this.transact(() => {
      if (release) { this.suppress([...this.journal.ownerCalls,...this.activeKeys()]); this.journal.ownerMeetingId = null; this.journal.ownerCalls = []; }
      if (suppress) this.suppress(this.activeKeys());
    });
  }

  private retire() {
    const removable = [...this.sources.values()].filter(s => !this.journal.ownerCalls.includes(keyOf(s))
      && (this.confirmedEnds.has(keyOf(s)) || (s.app === "meet" && this.now() - s.receivedAt > 60000)));
    const ended = removable.filter(s => this.confirmedEnds.has(keyOf(s))).map(keyOf);
    if (ended.some(k => this.journal.suppressed.includes(k))) this.transact(() => { this.journal.suppressed = this.journal.suppressed.filter(k => !ended.includes(k)); });
    for (const s of removable) {
      this.confirmedEnds.delete(keyOf(s)); this.attempts.delete(keyOf(s));
      if (s.app === "meet") { this.sources.delete(s.detectorId); this.retired.set(s.detectorId,s.sequence); }
      else { s.callId = null; s.joinedAt = null; s.endedAt = null; }
    }
    for (const key of this.confirmedEnds.keys()) if (!this.journal.ownerCalls.includes(key) && ![...this.sources.values()].some(s => keyOf(s) === key)) this.confirmedEnds.delete(key);
    for (const key of this.attempts.keys()) if (!this.journal.ownerCalls.includes(key) && ![...this.sources.values()].some(s => keyOf(s) === key)) this.attempts.delete(key);
    while(this.retired.size > 256) this.retired.delete(this.retired.keys().next().value!);
  }

  async tick() {
    if (this.busy) return;
    this.recordingChanged();
    const now = this.now(), snapshot = this.recording.snapshot();
    for (const s of this.sources.values()) {
      if (now - s.receivedAt > 15000 && s.state !== "unknown") { s.state = "unknown"; s.capability = "degraded"; s.joinedAt = null; s.endedAt = null; }
      if (s.state === "inactive" && s.endedAt !== null && now - s.endedAt >= 5000) this.confirmedEnds.set(keyOf(s), s.endedAt);
    }
    this.retire();
    if (this.automationBlocked || snapshot.maintenance || now < this.retryAt) return;
    const active = [...this.sources.values()].filter(s => this.journal.enabled[s.app] && s.callId && s.state === "active" && s.joinedAt !== null && now - s.joinedAt >= 3000);
    if (this.journal.ownerMeetingId) {
      const joined = active.map(keyOf).filter(k => !this.journal.suppressed.includes(k));
      const calls = [...new Set([...this.journal.ownerCalls, ...joined])];
      if (calls.length !== this.journal.ownerCalls.length) this.transact(() => { this.journal.ownerCalls = calls; });
      // Every joined owner must positively end. An inaccessible tab or process is unknown.
      const ended = this.journal.ownerCalls.length > 0 && this.journal.ownerCalls.every(k => this.confirmedEnds.has(k))
        && ![...this.sources.values()].some(s => this.journal.enabled[s.app] && s.state === "active" && !this.journal.suppressed.includes(keyOf(s)));
      if (!ended || snapshot.state !== "recording") return;
      this.busy = true;
      try {
        await this.recording.stop(`auto-stop-${randomUUID()}`, this.journal.ownerMeetingId);
        this.transact(() => { this.suppress(this.journal.ownerCalls); this.journal.ownerMeetingId = null; this.journal.ownerCalls = []; }); this.error = null; this.retire();
      } catch (e) { if (!this.automationBlocked) this.error = e instanceof Error ? e.message : "Automatic stop failed. Stop the recording manually."; this.retryAt = now + 5000; }
      finally { this.busy = false; }
      return;
    }
    if (!["idle", "completed", "failed"].includes(snapshot.state) || (snapshot.state === "failed" && snapshot.path)) return;
    const candidates = active.filter(s => !this.journal.suppressed.includes(keyOf(s)) && (this.attempts.get(keyOf(s)) ?? 0) < 3).sort((a,b) => a.joinedAt! - b.joinedAt! || a.detectorId.localeCompare(b.detectorId));
    if (!candidates.length) return;
    if (!this.isReady()) { this.error = "Automatic recording is waiting for capture permissions and a ready transcription model."; return; }
    const keys = candidates.map(keyOf), revision = this.manualRevision; this.busy = true;
    for (const k of keys) this.attempts.set(k, (this.attempts.get(k) ?? 0) + 1);
    try {
      const started = await this.recording.start(`auto-start-${randomUUID()}`, "both");
      if (started.state !== "recording" || !started.meetingId) throw new Error("Automatic recording did not become ready. Check capture permissions and models.");
      this.transact(() => {
        if (revision === this.manualRevision) { this.journal.ownerMeetingId = started.meetingId; this.journal.ownerCalls = keys; }
        else this.suppress(keys);
      });
      this.error = null;
    } catch (e) { if (!this.automationBlocked) this.error = e instanceof Error ? e.message : "Automatic start failed. Check capture permissions and models."; this.retryAt = now + 5000; }
    finally { this.busy = false; this.recordingChanged(); }
  }

  status() {
    const ending = [...this.sources.values()].filter(s => this.journal.ownerCalls.includes(keyOf(s)));
    const reconnectSeconds = this.journal.ownerMeetingId && ending.length && ending.every(s => s.state === "inactive" && s.endedAt !== null)
      ? Math.max(0,Math.ceil(Math.max(...ending.map(s => 5000 - (this.now() - s.endedAt!))) / 1000)) : null;
    return { reconnectSeconds, enabled: { ...this.journal.enabled }, ownerMeetingId: this.automationBlocked ? null : this.journal.ownerMeetingId, error: this.error, sources: [...this.sources.values()].map(s => ({ app: s.app, detectorId: s.detectorId, state: s.state, capability: s.capability, suppressed: this.journal.suppressed.includes(keyOf(s)), receivedAt: s.receivedAt })) };
  }
}
