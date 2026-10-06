import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJson } from "./atomic-json";
import { readPrivateJson } from "./connectors/private-json";
import {
  createKeychainVault,
  type SecretVault,
} from "./connectors/keychain-vault";
import { ProviderRegistry } from "./provider-registry";
import type { PortableLibrary } from "./portable-library";
import type { QuotaBudget } from "./portable-provider";
import { DirectSmbProvider } from "./smb-direct-provider";
import {
  PythonDirectSmbNative,
  validateDirectPending,
} from "./smb-direct-native";
import {
  DIRECT_SMB_CODES,
  DIRECT_SMB_UUID,
  directSmbError,
  exactObject,
  sameDirectIdentity,
  validateDirectBinding,
  validateDirectCredentials,
  validateDirectEndpoint,
  validateDirectProbe,
} from "./smb-direct-types";
import type {
  DirectSmbBinding,
  DirectSmbCredentials,
  DirectSmbEndpoint,
  DirectSmbNative,
  DirectSmbProbe,
} from "./smb-direct-types";
interface Job {
  attempts: number;
  next: number;
}
interface Connection {
  uncertainty: { operationId: string; generation: string } | null;
  binding: DirectSmbBinding;
  dialect: string;
  enabled: boolean;
  jobs: Record<string, Job>;
  acknowledged: string[];
  retryAt: number;
  failures: number;
  lastSync: number | null;
  imported: number;
  skipped: number;
  error: string | null;
}
interface Transition {
  previousConnections: Connection[];
  previousProviderId: string | null;
  newReference: string | null;
}
interface State {
  version: 1;
  connections: Connection[];
  cleanup: string[];
  transition?: Transition;
}
interface Receipt {
  endpoint: DirectSmbEndpoint;
  credentials: DirectSmbCredentials;
  probe: DirectSmbProbe;
  expiresAt: number;
}
interface Options {
  path: string;
  appDir: string;
  registry: ProviderRegistry;
  library: PortableLibrary | (() => PortableLibrary);
  busy: () => boolean;
  vault?: SecretVault;
  native?: DirectSmbNative;
  quota?: QuotaBudget;
  sessions?: () => Array<{
    id: string;
    transcriptFinalized?: boolean;
    files?: { wav?: string };
  }>;
  now?: () => number;
  write?: typeof atomicWriteJson;
}
const NOTICE =
  "Direct SMB synchronization unavailable. Preserve configuration and pending copies for recovery.";
const CONTROL_CODES = new Set([
  "receipt-expired",
  "stale-generation",
  "credential-unavailable",
  ...DIRECT_SMB_CODES,
]);
export function directConnectionError(code: string) {
  return Object.assign(new Error(NOTICE), {
    code: CONTROL_CODES.has(code) ? code : "transport-unavailable",
  });
}
export function directConnectionCode(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && CONTROL_CODES.has(code)
    ? code
    : "transport-unavailable";
}
const uuid = (v: unknown): v is string =>
  typeof v === "string" && DIRECT_SMB_UUID.test(v);
function title(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 120 ||
    /[\uD800-\uDFFF]/u.test(value) ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
  )
    throw directConnectionError("invalid-input");
  return value.trim();
}
function safeInteger(v: unknown, max = Number.MAX_SAFE_INTEGER) {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
}
function validateState(value: unknown): State {
  const state = exactObject(value, [
    "version",
    "connections",
    "cleanup",
    ...(value && typeof value === "object" && Object.hasOwn(value, "transition")
      ? ["transition"]
      : []),
  ]);
  if (
    state.version !== 1 ||
    !Array.isArray(state.connections) ||
    state.connections.length > 8 ||
    !Array.isArray(state.cleanup) ||
    state.cleanup.length > 8 ||
    state.cleanup.some((r) => !uuid(r))
  )
    throw directConnectionError("recovery-required");
  const ids = new Set<string>(),
    refs = new Set<string>();
  let enabled = 0,
    jobs = 0;
  for (const raw of state.connections) {
    const c = exactObject(raw, [
      "uncertainty",
      "binding",
      "dialect",
      "enabled",
      "jobs",
      "acknowledged",
      "retryAt",
      "failures",
      "lastSync",
      "imported",
      "skipped",
      "error",
    ]);
    const b = validateDirectBinding(c.binding);
    if (
      b.readOnly ||
      title(b.name) !== b.name ||
      ids.has(b.id) ||
      refs.has(b.credentialRef) ||
      typeof c.enabled !== "boolean" ||
      !["3.0", "3.0.2", "3.1.1"].includes(String(c.dialect)) ||
      !safeInteger(c.retryAt) ||
      !safeInteger(c.failures, 30) ||
      !safeInteger(c.imported) ||
      !safeInteger(c.skipped) ||
      (c.lastSync !== null && !safeInteger(c.lastSync)) ||
      (c.error !== null &&
        (typeof c.error !== "string" || !CONTROL_CODES.has(c.error))) ||
      !Array.isArray(c.acknowledged) ||
      c.acknowledged.length > 10000 ||
      c.acknowledged.some((id) => !uuid(id)) ||
      new Set(c.acknowledged).size !== c.acknowledged.length ||
      !c.jobs ||
      typeof c.jobs !== "object" ||
      Array.isArray(c.jobs)
    )
      throw directConnectionError("recovery-required");
    for (const [id, rawJob] of Object.entries(c.jobs)) {
      const job = exactObject(rawJob, ["attempts", "next"]);
      if (
        ++jobs > 10000 ||
        !uuid(id) ||
        !safeInteger(job.attempts, 30) ||
        !safeInteger(job.next)
      )
        throw directConnectionError("recovery-required");
    }
    if (c.uncertainty !== null) {
      const receipt = exactObject(c.uncertainty, ["operationId", "generation"]);
      if (
        !uuid(receipt.operationId) ||
        receipt.generation !== b.connectionGeneration
      )
        throw directConnectionError("recovery-required");
    }
    ids.add(b.id);
    refs.add(b.credentialRef);
    if (c.enabled && ++enabled > 1)
      throw directConnectionError("recovery-required");
  }
  if (state.transition) throw directConnectionError("recovery-required");
  return structuredClone(state) as unknown as State;
}
/** Device-only credentials and crash-safe selection; portable artifacts carry no connection data. */
export class DirectSmbConnections {
  private state: State = { version: 1, connections: [], cleanup: [] };
  private recovery = false;
  private unsafeDrain = false;
  private recovering = false;
  private testing = 0;
  private recoveryScope = new AsyncLocalStorage<{
    id: string;
    generation: string;
    operationId: string;
  }>();
  private receiptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private changing = false;
  private running = false;
  private closed = false;
  private native: DirectSmbNative;
  private vault?: SecretVault;
  private receipts = new Map<string, Receipt>();
  private providers = new Map<string, DirectSmbProvider>();
  private factories = new Map<string, () => DirectSmbProvider>();
  private tasks = new Map<AbortController, Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private loading?: Promise<void>;
  private draining?: Promise<void>;
  constructor(private options: Options) {
    this.native = options.native ?? new PythonDirectSmbNative();
    this.vault = options.vault;
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    try {
      if (existsSync(options.path))
        this.state = validateState(readPrivateJson(options.path, 16000000));
      if (this.state.cleanup.length) this.recovery = true;
      const preferred = options.registry.preferredId();
      if (
        this.state.connections.some(
          (c) => c.binding.id === preferred && !c.enabled,
        )
      )
        this.recovery = true;
    } catch {
      this.recovery = true;
    }
  }
  private library() {
    return typeof this.options.library === "function"
      ? this.options.library()
      : this.options.library;
  }
  private secretVault() {
    return (this.vault ??= createKeychainVault());
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  unavailable() {
    return this.recovery;
  }
  private basicAvailable() {
    if (this.recovery || this.unsafeDrain)
      throw directConnectionError("recovery-required");
    if (this.closed) throw directConnectionError("runtime-unavailable");
  }
  private available() {
    this.basicAvailable();
    if (
      this.state.connections.some((c) => c.uncertainty) &&
      !this.recoveryScope.getStore()
    )
      throw directConnectionError("recovery-required");
  }
  private persist(next: State) {
    if (Buffer.byteLength(JSON.stringify(next)) > 16000000)
      throw directConnectionError("bounds-exceeded");
    (this.options.write ?? atomicWriteJson)(this.options.path, next);
    this.state = next;
  }
  private edit(change: (s: State) => void) {
    const next = structuredClone(this.state);
    change(next);
    this.persist(next);
  }
  private current(id: string, generation?: string) {
    if (!uuid(id) || (generation !== undefined && !uuid(generation)))
      throw directConnectionError("invalid-input");
    const c = this.state.connections.find((c) => c.binding.id === id);
    if (
      !c ||
      (generation !== undefined &&
        c.binding.connectionGeneration !== generation)
    )
      throw directConnectionError("stale-generation");
    return c;
  }
  private reviewed(id: string, generation: string) {
    if (!uuid(generation)) throw directConnectionError("invalid-input");
    return this.current(id, generation);
  }
  private async owned<T>(
    run: (signal: AbortSignal) => Promise<T>,
    external?: AbortSignal,
    original = false,
  ): Promise<T> {
    if (original) this.basicAvailable();
    else this.available();
    if (this.draining) throw directConnectionError("destination-busy");
    const controller = new AbortController(),
      signal = external
        ? AbortSignal.any([controller.signal, external])
        : controller.signal;
    const task = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return run(signal);
    });
    this.tasks.set(controller, task);
    try {
      return await task;
    } finally {
      this.tasks.delete(controller);
    }
  }
  private capabilities(probe: {
    dialect: string;
    security: "signed" | "encrypted";
  }) {
    return {
      read: true,
      write: true,
      authentication: "authenticated" as const,
      dialect: probe.dialect,
      security: probe.security,
      encrypted: probe.security === "encrypted",
      durability: "share-readback" as const,
      remoteDeletion: true,
    };
  }
  snapshot() {
    return {
      recoveryRequired:
        this.recovery ||
        this.unsafeDrain ||
        ((!this.running || this.recovering) &&
          this.state.connections.some((c) => c.uncertainty)),
      syncing: this.running,
      connections: this.state.connections.map((c) => ({
        id: c.binding.id,
        generation: c.binding.connectionGeneration,
        name: c.binding.name,
        endpoint: structuredClone(c.binding.endpoint),
        destinationId: c.binding.destinationId,
        enabled: c.enabled,
        capabilities: this.capabilities({
          dialect: c.dialect,
          security: c.binding.security,
        }),
        progress: {
          pending: Object.keys(c.jobs).length,
          nextRetryAt: c.retryAt || null,
          lastSync: c.lastSync,
          imported: c.imported,
          skipped: c.skipped,
        },
        error: c.error ? { code: c.error, message: NOTICE } : null,
      })),
    };
  }
  private async nativeOneShot<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if ((error as { guardianStopped?: unknown })?.guardianStopped !== true) {
        this.unsafeDrain = true;
        throw directConnectionError("recovery-required");
      }
      throw error;
    }
  }
  private operationNative(c: Connection): DirectSmbNative {
    const generation = c.binding.connectionGeneration,
      id = c.binding.id;
    let completed: string | undefined,
      checkpointed = false,
      mustCheckpoint = false;
    const receipt = (operationId: string | null) => {
      try {
        this.edit((s) => {
          const current = s.connections.find((c) => c.binding.id === id);
          if (!current || current.binding.connectionGeneration !== generation)
            throw directConnectionError("stale-generation");
          current.uncertainty = operationId
            ? { operationId, generation }
            : null;
        });
      } catch {
        this.recovery = true;
        throw directConnectionError("recovery-required");
      }
    };
    const pending = async (...args: Parameters<DirectSmbNative["pending"]>) => {
      const jobs = validateDirectPending(
        await this.nativeOneShot(() => this.native.pending(...args)),
      );
      if (
        completed &&
        checkpointed &&
        !jobs.some((job) => job.operationId === completed)
      ) {
        receipt(null);
        completed = undefined;
      }
      return jobs;
    };
    return {
      probe: (...args) => this.nativeOneShot(() => this.native.probe(...args)),
      initialize: (...args) =>
        this.nativeOneShot(() => this.native.initialize(...args)),
      pending,
      open: async (binding, credentials, context, signal) => {
        this.available();
        const current = this.reviewed(id, generation),
          scope = this.recoveryScope.getStore();
        if (
          context.appDir !== this.options.appDir ||
          binding.id !== id ||
          binding.connectionGeneration !== generation ||
          !uuid(context.operationId)
        )
          throw directConnectionError("invalid-input");
        if (
          current.uncertainty &&
          (!scope ||
            scope.id !== id ||
            scope.generation !== generation ||
            scope.operationId !== context.operationId ||
            current.uncertainty.operationId !== context.operationId)
        )
          throw directConnectionError("recovery-required");
        // Durable before-effect uncertainty survives a crash even when no native journal is visible.
        receipt(context.operationId);
        completed = undefined;
        checkpointed = false;
        mustCheckpoint = !!scope;
        let session;
        try {
          session = await this.native.open(
            binding,
            credentials,
            context,
            signal,
          );
        } catch (error) {
          if (
            (error as { guardianStopped?: unknown })?.guardianStopped === true
          ) {
            const jobs = validateDirectPending(
              await this.nativeOneShot(() =>
                this.native.pending(binding, this.options.appDir),
              ),
            );
            if (
              !mustCheckpoint &&
              !jobs.some((job) => job.operationId === context.operationId)
            )
              receipt(null);
            throw error;
          }
          this.unsafeDrain = true;
          throw directConnectionError("recovery-required");
        }
        return {
          command: async (...args) => {
            if (
              [
                "write-deletion",
                "write-fence",
                "write-pending",
                "retire-pending",
                "remove-exact",
              ].includes(args[0])
            )
              checkpointed = false;
            const result = await session.command(...args);
            if (args[0] === "checkpoint") checkpointed = true;
            return result;
          },
          read: (...args) => session.read(...args),
          stream: (...args) => session.stream(...args),
          write: (...args) => {
            checkpointed = false;
            return session.write(...args);
          },
          close: async () => {
            try {
              await session.close();
              completed = context.operationId;
            } catch {
              this.unsafeDrain = true;
              throw directConnectionError("recovery-required");
            }
          },
        };
      },
    };
  }
  private provider(c: Connection) {
    const expected = c.binding.connectionGeneration,
      id = c.binding.id;
    return new DirectSmbProvider(
      c.binding,
      this.operationNative(c),
      async () => {
        this.available();
        const selected = this.reviewed(id, expected);
        if (
          (!selected.enabled && !this.recoveryScope.getStore()) ||
          this.library().snapshot().providerId !== id
        )
          throw directConnectionError("stale-generation");
        let value: unknown;
        try {
          value = await this.secretVault().get(selected.binding.credentialRef);
        } catch {
          throw directConnectionError("credential-unavailable");
        }
        this.available();
        if (
          this.reviewed(id, expected).binding.credentialRef !==
            selected.binding.credentialRef ||
          (!this.current(id).enabled && !this.recoveryScope.getStore())
        )
          throw directConnectionError("stale-generation");
        try {
          return validateDirectCredentials(value);
        } catch {
          throw directConnectionError("credential-unavailable");
        }
      },
      this.options.appDir,
      this.options.quota,
    );
  }
  private register(id: string) {
    let factory = this.factories.get(id);
    if (!factory) {
      factory = () => {
        this.basicAvailable();
        const provider = this.providers.get(id);
        if (!provider) throw directConnectionError("recovery-required");
        provider.pendingTransactions();
        return provider;
      };
      this.factories.set(id, factory);
    }
    this.options.registry.register(id, factory);
  }
  /** The registry must restore its preference only after this pure local asynchronous query completes. */
  ready(): Promise<void> {
    return (this.loading ??= this.owned(
      async (signal) => {
        for (const c of this.state.connections) {
          const provider = await this.provider(c).initialize(signal);
          this.providers.set(c.binding.id, provider);
          this.register(c.binding.id);
        }
      },
      undefined,
      true,
    ).catch((error) => {
      this.recovery = true;
      throw directConnectionError(directConnectionCode(error));
    }));
  }
  async start() {
    await this.ready();
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), 30000);
    this.timer.unref();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.receipts.clear();
    for (const timer of this.receiptTimers.values()) clearTimeout(timer);
    this.receiptTimers.clear();
    await this.preempt();
  }
  preempt(): Promise<void> {
    if (this.draining) return this.draining;
    const tasks = [...this.tasks.entries()];
    const check = () => {
      if (this.unsafeDrain) throw directConnectionError("recovery-required");
    };
    if (!tasks.length) return this.library().preempt().then(check);
    let finish!: () => void;
    this.draining = new Promise<void>((resolve) => (finish = resolve)).then(
      check,
    );
    for (const [controller] of tasks)
      controller.abort(directSmbError("transaction-unavailable"));
    void Promise.allSettled([
      this.library().preempt(),
      ...tasks.map(([, task]) => task),
    ]).then(() => {
      this.draining = undefined;
      finish();
    });
    return this.draining;
  }
  private forgetReceipt(key: string) {
    this.receipts.delete(key);
    clearTimeout(this.receiptTimers.get(key));
    this.receiptTimers.delete(key);
  }
  private prune() {
    for (const [key, r] of this.receipts)
      if (r.expiresAt <= this.now()) this.forgetReceipt(key);
  }
  private protectedProbe(value: unknown, endpoint: DirectSmbEndpoint) {
    const p = validateDirectProbe(value);
    if (p.readOnly) throw directConnectionError("read-only");
    if (endpoint.requireEncryption && !p.encrypted)
      throw directConnectionError("unsupported-security");
    if (!p.destinationId && !p.empty)
      throw directConnectionError("unsupported-destination");
    return p;
  }
  async test(endpoint: unknown, credentials: unknown, signal?: AbortSignal) {
    this.available();
    const e = validateDirectEndpoint(endpoint),
      c = validateDirectCredentials(credentials);
    this.prune();
    if (this.receipts.size + this.testing >= 8)
      throw directConnectionError("bounds-exceeded");
    this.testing++;
    try {
      return await this.owned(async (effective) => {
        const probe = this.protectedProbe(
          await this.nativeOneShot(() => this.native.probe(e, c, effective)),
          e,
        );
        effective.throwIfAborted();
        this.prune();
        if (this.receipts.size >= 8)
          throw directConnectionError("bounds-exceeded");
        const receipt = randomUUID(),
          expiresAt = this.now() + 300000;
        this.receipts.set(receipt, {
          endpoint: e,
          credentials: c,
          probe,
          expiresAt,
        });
        const timer = setTimeout(() => this.forgetReceipt(receipt), 300000);
        timer.unref();
        this.receiptTimers.set(receipt, timer);
        return {
          receipt,
          expiresAt,
          endpoint: e,
          destinationId: probe.destinationId,
          needsCreation: !probe.destinationId,
          capabilities: this.capabilities(probe),
        };
      }, signal);
    } finally {
      this.testing--;
    }
  }
  private async cleanup() {
    for (const reference of [...this.state.cleanup]) {
      try {
        await this.secretVault().remove(reference);
        this.edit((s) => {
          s.cleanup = s.cleanup.filter((r) => r !== reference);
        });
      } catch {
        this.recovery = true;
        throw directConnectionError("recovery-required");
      }
    }
  }
  private async transition(
    change: (s: State) => void,
    effect: () => Promise<void>,
    newReference: string | null = null,
    target: string | null = this.options.registry.preferredId() ?? null,
  ) {
    const previous = structuredClone(this.state),
      oldProviders = new Map(this.providers),
      preferred = this.options.registry.preferredId() ?? null;
    this.edit((s) => {
      s.transition = {
        previousConnections: structuredClone(previous.connections),
        previousProviderId: preferred,
        newReference,
      };
    });
    try {
      await effect();
      this.edit((s) => {
        change(s);
      });
      for (const c of this.state.connections) this.register(c.binding.id);
      if (target) this.options.registry.activate(target);
      else
        for (const c of previous.connections)
          this.options.registry.deactivate(c.binding.id);
      const retired = previous.connections
        .map((c) => c.binding.credentialRef)
        .filter(
          (ref) =>
            !this.state.connections.some(
              (c) => c.binding.credentialRef === ref,
            ),
        );
      this.edit((s) => {
        delete s.transition;
        s.cleanup = [...new Set([...s.cleanup, ...retired])];
      });
    } catch (error) {
      try {
        this.providers = oldProviders;
        for (const c of previous.connections) this.register(c.binding.id);
        if (preferred) this.options.registry.activate(preferred);
        else
          for (const c of this.state.connections)
            this.options.registry.deactivate(c.binding.id);
        for (const id of this.factories.keys())
          if (!previous.connections.some((c) => c.binding.id === id)) {
            this.options.registry.unregister(id);
            this.factories.delete(id);
          }
        this.persist({
          ...previous,
          cleanup: [
            ...new Set([
              ...previous.cleanup,
              ...(newReference ? [newReference] : []),
            ]),
          ],
        });
        await this.cleanup();
      } catch {
        this.recovery = true;
        throw directConnectionError("recovery-required");
      }
      throw directConnectionError(directConnectionCode(error));
    }
    await this.cleanup();
  }
  private async control<T>(run: (signal: AbortSignal) => Promise<T>) {
    this.available();
    if (this.changing || this.options.busy())
      throw directConnectionError("destination-busy");
    this.changing = true;
    try {
      return await this.owned((signal) =>
        this.options.registry.withMutation(() => run(signal), signal),
      );
    } catch (error) {
      if (this.recovery || this.unsafeDrain)
        throw directConnectionError("recovery-required");
      if (this.library().isBusy() || this.options.busy())
        throw directConnectionError("destination-busy");
      throw directConnectionError(directConnectionCode(error));
    } finally {
      this.changing = false;
    }
  }
  private async originalRecovered(c: Connection, signal: AbortSignal) {
    const provider = this.providers.get(c.binding.id) ?? this.provider(c);
    await provider.initialize(signal);
    if (
      provider.pendingTransactions().length ||
      this.library()
        .deletionJobs()
        .some(
          (job) =>
            job.selection.providerId === c.binding.id &&
            ["prepared", "deleting", "incomplete"].includes(job.state),
        )
    )
      throw directConnectionError("recovery-required");
  }
  async connect(input: {
    name: string;
    receipt: string;
    create: boolean;
    connectionId?: string;
    generation?: string;
  }) {
    if (this.running && !this.recovering && !this.unsafeDrain)
      this.basicAvailable();
    else this.available();
    const name = title(input.name);
    if (
      !uuid(input.receipt) ||
      typeof input.create !== "boolean" ||
      (input.connectionId === undefined) !== (input.generation === undefined)
    )
      throw directConnectionError("invalid-input");
    this.prune();
    const receipt = this.receipts.get(input.receipt);
    if (!receipt) throw directConnectionError("receipt-expired");
    if (input.connectionId)
      this.reviewed(input.connectionId, input.generation!);
    if (!input.connectionId && this.state.connections.length >= 8)
      throw directConnectionError("bounds-exceeded");
    if (!receipt.probe.destinationId && !input.create)
      throw directConnectionError("invalid-input");
    if (this.changing) throw directConnectionError("destination-busy");
    await this.preempt();
    return this.control(async (signal) => {
      this.forgetReceipt(input.receipt);
      const old = input.connectionId
        ? this.reviewed(input.connectionId, input.generation!)
        : undefined;
      if (old) await this.originalRecovered(old, signal);
      const probe = this.protectedProbe(
        await this.nativeOneShot(() =>
          this.native.probe(receipt.endpoint, receipt.credentials, signal),
        ),
        receipt.endpoint,
      );
      if (
        !sameDirectIdentity(probe.identity, receipt.probe.identity) ||
        probe.destinationId !== receipt.probe.destinationId ||
        probe.security !== receipt.probe.security
      )
        throw directConnectionError("identity-changed");
      if (
        old &&
        (old.binding.destinationId !== probe.destinationId ||
          !sameDirectIdentity(old.binding.identity, probe.identity) ||
          JSON.stringify(old.binding.endpoint) !==
            JSON.stringify(receipt.endpoint))
      )
        throw directConnectionError("identity-changed");
      const reference = randomUUID(),
        id = old?.binding.id ?? randomUUID();
      let next: Connection | undefined;
      await this.transition(
        (s) => {
          for (const c of s.connections) c.enabled = false;
          s.connections = s.connections.filter((c) => c.binding.id !== id);
          s.connections.push(next!);
        },
        async () => {
          try {
            if (
              (await this.secretVault().put(receipt.credentials, reference)) !==
              reference
            )
              throw new Error();
          } catch {
            throw directConnectionError("credential-unavailable");
          }
          let reviewed = probe;
          if (!probe.destinationId) {
            reviewed = this.protectedProbe(
              await this.nativeOneShot(() =>
                this.native.initialize(
                  receipt.endpoint,
                  receipt.credentials,
                  probe.identity,
                  randomUUID(),
                  signal,
                ),
              ),
              receipt.endpoint,
            );
            if (
              !sameDirectIdentity(reviewed.identity, probe.identity) ||
              !reviewed.destinationId
            )
              throw directConnectionError("identity-changed");
          }
          const binding = validateDirectBinding({
            id,
            name,
            endpoint: receipt.endpoint,
            identity: reviewed.identity,
            destinationId: reviewed.destinationId,
            destinationVersion: 3,
            connectionGeneration: randomUUID(),
            credentialRef: reference,
            readOnly: false,
            security: reviewed.security,
          });
          next = {
            uncertainty: null,
            binding,
            dialect: reviewed.dialect,
            enabled: true,
            jobs: old?.jobs ?? {},
            acknowledged: old?.acknowledged ?? [],
            retryAt: 0,
            failures: 0,
            lastSync: old?.lastSync ?? null,
            imported: old?.imported ?? 0,
            skipped: old?.skipped ?? 0,
            error: null,
          };
          this.providers.set(id, await this.provider(next).initialize(signal));
          signal.throwIfAborted();
        },
        reference,
        id,
      );
      return this.snapshot();
    });
  }
  async rename(id: string, generation: string, value: string) {
    this.reviewed(id, generation);
    const name = title(value);
    return this.control(async (signal) => {
      const c = this.reviewed(id, generation),
        changed = structuredClone(c);
      await this.originalRecovered(c, signal);
      changed.binding.name = name;
      await this.transition(
        (s) => {
          s.connections.find((c) => c.binding.id === id)!.binding.name = name;
        },
        async () => {
          this.providers.set(
            id,
            await this.provider(changed).initialize(signal),
          );
        },
      );
      return this.snapshot();
    });
  }
  async enable(id: string, generation: string, enabled: boolean) {
    if (this.running && !this.recovering && !this.unsafeDrain)
      this.basicAvailable();
    else this.available();
    this.reviewed(id, generation);
    if (typeof enabled !== "boolean")
      throw directConnectionError("invalid-input");
    if (this.changing) throw directConnectionError("destination-busy");
    await this.preempt();
    return this.control(async (signal) => {
      const c = this.reviewed(id, generation);
      await this.transition(
        (s) => {
          for (const c of s.connections)
            if (c.binding.id === id) c.enabled = enabled;
            else if (enabled) c.enabled = false;
        },
        async () => {
          this.providers.set(id, await this.provider(c).initialize(signal));
        },
        null,
        enabled
          ? id
          : this.options.registry.preferredId() === id
            ? null
            : (this.options.registry.preferredId() ?? null),
      );
      return this.snapshot();
    });
  }
  async disconnect(id: string, generation: string) {
    if (this.running && !this.recovering && !this.unsafeDrain)
      this.basicAvailable();
    else this.available();
    this.reviewed(id, generation);
    if (this.changing) throw directConnectionError("destination-busy");
    await this.preempt();
    return this.control(async (signal) => {
      const c = this.reviewed(id, generation);
      await this.originalRecovered(c, signal);
      await this.transition(
        (s) => {
          s.connections = s.connections.filter((c) => c.binding.id !== id);
        },
        async () => {},
        null,
        this.options.registry.preferredId() === id
          ? null
          : (this.options.registry.preferredId() ?? null),
      );
      this.options.registry.unregister(id);
      this.providers.delete(id);
      this.factories.delete(id);
      return this.snapshot();
    });
  }
  private pendingProtection() {
    const revisionIds = new Set<string>();
    let pending = false,
      uncertain = false;
    for (const c of this.state.connections) {
      pending ||= Object.keys(c.jobs).length > 0;
      uncertain ||= !!c.uncertainty;
      const provider = this.providers.get(c.binding.id);
      if (!provider) {
        uncertain = true;
        continue;
      }
      try {
        const jobs = provider.pendingTransactions();
        pending ||= jobs.length > 0;
        for (const job of jobs)
          for (const admission of job.admissions)
            revisionIds.add(admission.revisionId);
      } catch {
        uncertain = true;
      }
    }
    return { revisionIds, pending, uncertain };
  }
  protectedRevisionIds() {
    if (!this.state.connections.length) return [];
    const protection = this.pendingProtection(),
      ids = new Set([
        ...this.state.connections.flatMap((c) => Object.keys(c.jobs)),
        ...protection.revisionIds,
      ]);
    const active = this.state.connections.find((c) => c.enabled);
    for (const p of this.library().snapshot().previews)
      if (
        p.local &&
        !p.deleted &&
        (this.recovery ||
          protection.uncertain ||
          (active && !active.acknowledged.includes(p.revisionId)))
      )
        ids.add(p.revisionId);
    return [...ids];
  }
  protectedLocalPaths() {
    const protection = this.pendingProtection(),
      active = this.state.connections.some((c) => c.enabled);
    return this.recovery || active || protection.pending || protection.uncertain
      ? (this.options.sessions?.() ?? [])
          .filter((s) => s.transcriptFinalized === true && s.files?.wav)
          .map((s) => s.files!.wav!)
      : [];
  }
  private async recoverOriginal(c: Connection) {
    this.basicAvailable();
    if (
      this.running ||
      this.changing ||
      this.draining ||
      this.options.busy() ||
      this.library().isBusy()
    )
      throw directConnectionError("destination-busy");
    const original = c.uncertainty!;
    this.running = true;
    this.recovering = true;
    try {
      await this.owned(
        async (signal) => {
          const provider = this.providers.get(c.binding.id) ?? this.provider(c);
          await provider.initialize(signal);
          this.providers.set(c.binding.id, provider);
          const job = provider
            .pendingTransactions()
            .find((j) => j.operationId === original.operationId);
          if (!job || !job.recoverable || job.blockedReason)
            throw directConnectionError("recovery-required");
          await this.recoveryScope.run(
            {
              id: c.binding.id,
              generation: original.generation,
              operationId: original.operationId,
            },
            () =>
              this.library().reconcileTransaction(
                original.operationId,
                signal,
                false,
                provider,
              ),
          );
          await provider.initialize(signal);
          if (
            this.current(c.binding.id).uncertainty ||
            provider
              .pendingTransactions()
              .some((j) => j.operationId === original.operationId)
          )
            throw directConnectionError("recovery-required");
          this.unsafeDrain = false;
          this.edit((s) => {
            s.connections.find((c) => c.binding.id === provider.id)!.error =
              null;
          });
        },
        undefined,
        true,
      );
    } catch {
      try {
        this.edit((s) => {
          s.connections.find(
            (item) => item.binding.id === c.binding.id,
          )!.error = "recovery-required";
        });
      } catch {
        this.recovery = true;
      }
      throw directConnectionError("recovery-required");
    } finally {
      this.running = false;
      this.recovering = false;
    }
    return this.snapshot();
  }
  async sync(id: string, generation: string) {
    this.basicAvailable();
    const c = this.reviewed(id, generation);
    if (c.uncertainty) return this.recoverOriginal(c);
    this.available();
    if (!c.enabled) throw directConnectionError("stale-generation");
    if (
      this.running ||
      this.changing ||
      this.options.busy() ||
      this.library().isBusy()
    )
      throw directConnectionError("destination-busy");
    await this.tick(true);
    return this.snapshot();
  }
  async tick(force = false) {
    this.available();
    if (
      this.running ||
      this.changing ||
      this.draining ||
      this.options.busy() ||
      this.library().isBusy()
    )
      return;
    const c = this.state.connections.find((c) => c.enabled);
    if (!c || (!force && (c.failures >= 30 || c.retryAt > this.now()))) return;
    this.running = true;
    try {
      await this.owned(async (signal) => {
        const provider = this.providers.get(c.binding.id) ?? this.provider(c);
        await provider.initialize(signal);
        this.providers.set(c.binding.id, provider);
        const pending = provider.pendingTransactions();
        for (const job of pending) {
          if (!job.recoverable || job.blockedReason)
            throw directConnectionError("recovery-required");
          await this.library().reconcileTransaction(
            job.operationId,
            signal,
            false,
            provider,
          );
        }
        await provider.initialize(signal);
        if (provider.pendingTransactions().length)
          throw directConnectionError("recovery-required");
        await this.library().withProvider(
          provider,
          async (library, effective) => {
            for (const meeting of library.snapshot().localMeetings ?? []) {
              effective.throwIfAborted();
              const revision = await library.queueLocal(meeting.id, effective);
              if (library.hasLocalPublication(revision.revisionId)) continue;
              this.edit((s) => {
                const current = s.connections.find(
                  (c) => c.binding.id === provider.id,
                )!;
                if (
                  !current.jobs[revision.revisionId] &&
                  s.connections.reduce(
                    (n, c) => n + Object.keys(c.jobs).length,
                    0,
                  ) >= 10000
                )
                  throw directConnectionError("bounds-exceeded");
                current.jobs[revision.revisionId] ??= { attempts: 0, next: 0 };
              });
            }
            for (const [revisionId, job] of Object.entries(
              this.current(provider.id).jobs,
            )) {
              if (!force && job.next > this.now()) continue;
              effective.throwIfAborted();
              if (!library.hasLocalRevision(revisionId)) continue;
              await library.publish(revisionId, effective);
              const p = library
                .snapshot()
                .previews.find((p) => p.revisionId === revisionId);
              if (
                p?.state !== "verified" ||
                !library.hasLocalPublication(revisionId)
              )
                throw directConnectionError("recovery-required");
              this.edit((s) => {
                const c = s.connections.find(
                  (c) => c.binding.id === provider.id,
                )!;
                delete c.jobs[revisionId];
                if (!c.acknowledged.includes(revisionId)) {
                  if (c.acknowledged.length >= 10000)
                    throw directConnectionError("bounds-exceeded");
                  c.acknowledged.push(revisionId);
                }
              });
            }
            await library.discover(effective);
            if (!library.snapshot().complete)
              throw directConnectionError("transport-unavailable");
            await library.importSelected(undefined, effective);
          },
          signal,
        );
        signal.throwIfAborted();
        this.edit((s) => {
          const c = s.connections.find((c) => c.binding.id === provider.id)!;
          c.retryAt = 0;
          c.failures = 0;
          c.lastSync = this.now();
          c.error = null;
          c.imported = this.library().snapshot().imported;
          c.skipped = this.library().snapshot().skipped;
        });
      });
    } catch (error) {
      if (!this.closed)
        try {
          this.edit((s) => {
            const current = s.connections.find(
              (item) => item.binding.id === c.binding.id,
            );
            if (!current) return;
            current.failures = Math.min(30, current.failures + 1);
            const next =
              this.now() +
              Math.min(3600000, 30000 * 2 ** Math.min(current.failures - 1, 7));
            current.retryAt = next;
            current.error = current.uncertainty
              ? "recovery-required"
              : directConnectionCode(error);
            for (const job of Object.values(current.jobs)) {
              job.attempts = Math.min(30, job.attempts + 1);
              job.next = next;
            }
          });
        } catch {
          this.recovery = true;
        }
    } finally {
      this.running = false;
    }
  }
}
