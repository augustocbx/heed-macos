export type PermissionAction = 'microphone' | 'screenCapture' | 'slackLogs';
export type MicrophonePermission = 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown';
export interface DesktopPermissionSnapshot {
 microphone: MicrophonePermission;
 screenCapture: boolean | null;
 slackLogs: boolean | null;
 slackAutoRecord: boolean | null;
}
export interface PermissionReport {
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
   && ['5170', String(port)].includes(source.port);
 } catch { return false; }
}

function object(value: unknown): value is Record<string, unknown> {
 return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function permissionAction(body: unknown): PermissionAction | null {
 if (!object(body) || !['microphone', 'screenCapture', 'slackLogs'].includes(String(body.action))) return null;
 return typeof body.action === 'string' ? body.action as PermissionAction : null;
}
export function permissionReport(body: unknown): PermissionReport | null {
 if (!object(body) || !object(body.permissions)) return null;
 const p = body.permissions;
 if (typeof p.microphone !== 'string' || !['authorized', 'denied', 'restricted', 'notDetermined', 'unknown'].includes(p.microphone)) return null;
 for (const key of ['screenCapture', 'slackLogs', 'slackAutoRecord']) {
  if (p[key] !== null && typeof p[key] !== 'boolean') return null;
 }
 if (body.commandId !== undefined && (typeof body.commandId !== 'string' || !body.commandId.length || body.commandId.length > 100)) return null;
 if (body.error !== undefined && body.error !== null && (typeof body.error !== 'string' || body.error.length > 2048)) return null;
 return { permissions: {
  microphone: p.microphone as MicrophonePermission,
  screenCapture: p.screenCapture as boolean | null,
  slackLogs: p.slackLogs as boolean | null,
  slackAutoRecord: p.slackAutoRecord as boolean | null,
 }, ...(body.commandId === undefined ? {} : { commandId: body.commandId as string }),
 ...(body.error === undefined ? {} : { error: body.error as string | null }) };
}

/** Ponte independente dos comandos de gravação; o aplicativo confirma por ID. */
export class DesktopPermissions {
 private command: PermissionCommand | null = null;
 private permissions: DesktopPermissionSnapshot | null = null;
 private updatedAt: number | null = null;
 private error: string | null = null;
 private expire(now: number) {
  if (this.command && now - this.command.createdAt >= 90_000) {
   this.command = null;
   this.error = 'O pedido de permissão expirou. Abra o ícone do Heed e tente novamente.';
  }
 }
 status(now = Date.now()) {
  this.expire(now);
  const controllerConnected = this.updatedAt !== null && now - this.updatedAt < 12_000;
  return { controllerConnected, updatedAt: this.updatedAt,
   permissions: controllerConnected && this.permissions ? { ...this.permissions } : null,
   error: this.error, pending: this.command !== null };
 }
 request(now = Date.now()) {
  this.expire(now);
  return this.command ? { id: this.command.id, action: this.command.action } : null;
 }
 enqueue(action: PermissionAction, now = Date.now()) {
  this.expire(now);
  if (this.command) throw new Error('Já existe um pedido de permissão em andamento.');
  this.command = { id: crypto.randomUUID(), action, createdAt: now };
  this.error = null;
  return this.command.id;
 }
 report(report: PermissionReport, now = Date.now()) {
  this.expire(now);
  this.permissions = { ...report.permissions };
  this.updatedAt = now;
  if (report.commandId && this.command?.id === report.commandId) {
   this.command = null;
   this.error = report.error ?? null;
  } else if (report.error !== undefined && !report.commandId) {
   // Heartbeats atualizam o diagnóstico, mas não consomem pedidos ainda abertos.
   if (!this.command) this.error = report.error;
  }
 }
}
