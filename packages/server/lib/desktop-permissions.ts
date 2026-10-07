import {configuredServicePorts} from './service-ports';
export type PermissionAction = 'microphone' | 'screenCapture' | 'recoverScreenCapture' | 'slackLogs' | 'accessibility';
export type MicrophonePermission = 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown';
export interface DesktopPermissionSnapshot {
 microphone: MicrophonePermission;
 screenCapture: boolean | null;
 slackLogs: boolean | null;
 slackAutoRecord: boolean | null;
}
export interface PermissionBuild { version: string; commit: string | null; instanceId: string }
export interface PermissionReport {
 recoverySupported?: boolean;
 build?: PermissionBuild;
 permissions: DesktopPermissionSnapshot;
 commandId?: string;
 error?: string | null;
}
interface PermissionCommand { id: string; action: PermissionAction; createdAt: number }

export function desktopRequestAllowed(req: Request, port: number | string): boolean {
 const url = new URL(req.url);
 const local = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
 if (!local(url.hostname)) return false;
 const origin = req.headers.get('origin');
 if (!origin) return true;
 try {
  const source = new URL(origin);
  return ['http:', 'https:'].includes(source.protocol) && local(source.hostname)
   && [String(configuredServicePorts().ui), String(port)].includes(source.port);
 } catch { return false; }
}

function object(value: unknown): value is Record<string, unknown> {
 return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function permissionAction(body: unknown): PermissionAction | null {
 if (!object(body) || !['microphone', 'screenCapture', 'recoverScreenCapture', 'slackLogs', 'accessibility'].includes(String(body.action))) return null;
 return typeof body.action === 'string' ? body.action as PermissionAction : null;
}
export function permissionReport(body: unknown): PermissionReport | null {
 if (!object(body) || !object(body.permissions)) return null;
 if (body.recoverySupported !== undefined && typeof body.recoverySupported !== 'boolean') return null;
 const p = body.permissions;
 if (typeof p.microphone !== 'string' || !['authorized', 'denied', 'restricted', 'notDetermined', 'unknown'].includes(p.microphone)) return null;
 for (const key of ['screenCapture', 'slackLogs', 'slackAutoRecord']) {
  if (p[key] !== null && typeof p[key] !== 'boolean') return null;
 }
 if (body.build !== undefined && (!object(body.build) || typeof body.build.version !== 'string'
  || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(body.build.version)
  || (body.build.commit !== null && (typeof body.build.commit !== 'string' || !/^[a-f0-9]{40}$/.test(body.build.commit)))
  || typeof body.build.instanceId !== 'string' || !body.build.instanceId.length || body.build.instanceId.length > 100)) return null;
 if (body.commandId !== undefined && (typeof body.commandId !== 'string' || !body.commandId.length || body.commandId.length > 100)) return null;
 if (body.error !== undefined && body.error !== null && (typeof body.error !== 'string' || body.error.length > 2048)) return null;
 return { permissions: {
  microphone: p.microphone as MicrophonePermission,
  screenCapture: p.screenCapture as boolean | null,
  slackLogs: p.slackLogs as boolean | null,
  slackAutoRecord: p.slackAutoRecord as boolean | null,
 }, ...(body.recoverySupported === undefined ? {} : {recoverySupported: body.recoverySupported as boolean}), ...(body.build === undefined ? {} : {build: {...body.build as unknown as PermissionBuild}}), ...(body.commandId === undefined ? {} : { commandId: body.commandId as string }),
 ...(body.error === undefined ? {} : { error: body.error as string | null }) };
}

/** Bridge independent of recording commands; the app acknowledges requests by ID. */
export class DesktopPermissions {
 private command: PermissionCommand | null = null;
 private permissions: DesktopPermissionSnapshot | null = null;
 private build: PermissionBuild | null = null;
 private recoverySupported = false;
 private updatedAt: number | null = null;
 private error: string | null = null;
 private expire(now: number) {
  if (this.command && now - this.command.createdAt >= 90_000) {
   this.command = null;
   this.error = 'The permission request expired. Open the Heed menu bar app and try again.';
  }
 }
 status(now = Date.now()) {
  this.expire(now);
  const controllerConnected = this.updatedAt !== null && now - this.updatedAt < 12_000;
  return { controllerConnected, updatedAt: this.updatedAt, build: controllerConnected && this.build ? {...this.build} : null,
   permissions: controllerConnected && this.permissions ? { ...this.permissions } : null,
   error: this.error, pending: this.command !== null };
 }
 recovery(state: {active: string[]; maintenance: boolean}, now = Date.now()): {recoveryAvailable: boolean; recoveryBlockedReason?: string} {
  const status = this.status(now);
  let recoveryBlockedReason: string | undefined;
  if (!status.controllerConnected || !status.build || !this.recoverySupported) recoveryBlockedReason = 'Open the updated Heed menu app to recover system audio access.';
  else if (state.maintenance) recoveryBlockedReason = 'Wait for the update or maintenance to finish before recovering system audio access.';
  else if (state.active.length) recoveryBlockedReason = 'Wait for recording, transcription or other processing to finish before recovering system audio access.';
  else if (status.permissions?.screenCapture !== false) recoveryBlockedReason = 'System audio recovery is available only when access is unavailable.';
  return recoveryBlockedReason ? {recoveryAvailable:false,recoveryBlockedReason} : {recoveryAvailable:true};
 }
 request(now = Date.now()) {
  this.expire(now);
  return this.command ? { id: this.command.id, action: this.command.action } : null;
 }
 enqueue(action: PermissionAction, now = Date.now()) {
  this.expire(now);
  if (this.command) throw new Error('A permission request is already pending.');
  this.command = { id: crypto.randomUUID(), action, createdAt: now };
  this.error = null;
  return this.command.id;
 }
 report(report: PermissionReport, now = Date.now()) {
  this.expire(now);
  this.permissions = { ...report.permissions };
  this.recoverySupported = report.recoverySupported === true;
  this.build = report.build ? {...report.build} : null;
  this.updatedAt = now;
  if (report.commandId && this.command?.id === report.commandId) {
   this.command = null;
   this.error = report.error ?? null;
  } else if (report.error !== undefined && !report.commandId) {
   // Heartbeats update diagnostics without consuming open requests.
   if (!this.command) this.error = report.error;
  }
 }
}

/** Lifecycle admission needs no recording paths, saved meetings or transcript segments. */
export function permissionRecoverySummary(status: Record<string, unknown>) {
 return Object.fromEntries(['recording','processing','starting','pending','audioWork','maintenance',
  'maintenanceProtocol','processingKinds','updateTransactionId','permissionRequest'].map(key=>[key,status[key]]));
}
