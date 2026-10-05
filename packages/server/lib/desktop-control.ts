export type DesktopAction = 'start' | 'stop';
export interface ClientState { recording: boolean; processing: boolean; seconds: number; ready?:boolean; commandId?:string }
interface Command { id: string; action: DesktopAction; language: 'pt' | 'en'; created: number; client: string | null; leasedAt:number }

/** Single-consumer bridge: reuse the browser's transcription and session-save flow. */
export class DesktopControl {
 private command: Command | null = null;
 private clients = new Map<string, ClientState & {seen:number}>();
 private owner: string | null = null;
 error: string | null = null;
 get pending() { return this.command !== null; }
 cancelPending() { this.command = null; }
 heartbeat(client: string, state: ClientState, now = Date.now()) {
  this.clients.set(client, {...state, seen:now});
  if (this.command?.client === client && state.commandId === this.command.id) this.command.leasedAt = now;
  if (!this.owner && (state.recording || state.processing)) this.owner = client;
  for (const [id, entry] of this.clients) if (now - entry.seen > 60000) this.clients.delete(id);
 }
 status(now = Date.now()) {
  this.expire(now);
  const entries = [...this.clients.values()].filter(c => now - c.seen < 10000);
  const own = this.owner ? this.clients.get(this.owner) : null;
  return {ready:entries.some(c => c.ready), clientConnected: entries.length > 0, processing: entries.some(c => c.processing), seconds: own?.seconds ?? 0, error:this.error, pending:this.pending};
 }
 enqueue(action: DesktopAction, language: 'pt'|'en', state: {recording:boolean;processing:boolean}, now = Date.now()) {
  this.expire(now);
  if (this.command) throw new Error('A recording command is already pending');
  if (action === 'start' && state.recording) throw new Error('Heed is already recording');
  if (action === 'start' && state.processing) throw new Error('Heed is still processing the previous recording');
  if (action === 'stop' && !state.recording) throw new Error('Heed is not recording');
  this.error = null;
  this.command = {id:crypto.randomUUID(), action, language, created:now, client:null, leasedAt:now};
  return this.command.id;
 }
 private expire(now:number) {
  if (this.command?.client && now - this.command.leasedAt > 20000) {
   this.command = null; this.error = "Recording controller disconnected. Open the interface and check the capture before retrying.";
  }
  if (this.command && !this.command.client && now - this.command.created > 90000) {
   this.command = null; this.error = 'Recording command expired. Open the interface and try again.';
  }
 }
 claim(client:string, now = Date.now(), executingCommandId?: string) {
  this.expire(now);
  if (executingCommandId || !this.command || this.command.client) return null;
  // A single claimed command is sufficient for exclusivity. Any connected tab can
  // stop a native recording when the original tab is idle, suspended or replaced.
  this.command.client = client;
  this.command.leasedAt = now;
  this.owner = client;
  return {...this.command};
 }
 complete(id:string, client:string, error:string|null) {
  if (!this.command || this.command.id !== id || this.command.client !== client) throw new Error('Command does not belong to this browser');
  this.error = error;
  this.command = null;
 }
}
