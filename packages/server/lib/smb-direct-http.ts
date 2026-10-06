import { desktopRequestAllowed } from "./desktop-permissions";
import {
  directConnectionCode,
  directConnectionError,
  type DirectSmbConnections,
} from "./smb-direct-connections";
import {
  DIRECT_SMB_UUID,
  exactObject,
  validateDirectCredentials,
  validateDirectEndpoint,
} from "./smb-direct-types";
const headers = { "Cache-Control": "no-store" };
const reply = (value: unknown, status = 200) =>
  Response.json(value, { status, headers });
function invalid(): never {
  throw directConnectionError("invalid-input");
}
function uuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !DIRECT_SMB_UUID.test(value)) invalid();
}
function name(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 120 ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
  )
    invalid();
}
function strictJson(text: string) {
  const parsed = JSON.parse(text),
    stack: Array<Set<string> | null> = [];
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]]/g;
  for (const token of text.matchAll(tokens)) {
    const value = token[0];
    if (value === "{" || value === "[") {
      if (stack.length >= 64) invalid();
      stack.push(value === "{" ? new Set() : null);
    } else if (value === "}" || value === "]") stack.pop();
    else if (/^\s*:/.test(text.slice(token.index! + value.length))) {
      const keys = stack.at(-1);
      if (!keys) invalid();
      const key = JSON.parse(value);
      if (keys.has(key)) invalid();
      keys.add(key);
    }
  }
  return parsed;
}
async function body(request: Request) {
  if (Number(request.headers.get("content-length")) > 16384) invalid();
  const reader = request.body?.getReader();
  if (!reader) invalid();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 16384) {
        await reader.cancel();
        invalid();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return strictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    invalid();
  }
}
/** All responses are bounded and sanitized, including local-origin rejection and transport failures. */
export async function directSmbResponse(
  request: Request,
  connections: DirectSmbConnections | undefined,
): Promise<Response> {
  if (!desktopRequestAllowed(request, new URL(request.url).port))
    return reply(
      {
        error: "Synchronization controls are only available from this Mac.",
        code: "forbidden",
      },
      403,
    );
  if (request.method !== "GET" && request.method !== "POST")
    return new Response(null, { status: 405, headers });
  if (!connections || connections.unavailable())
    return reply(
      {
        error:
          "Direct SMB synchronization unavailable. Preserve configuration and pending copies for recovery.",
        code: "recovery-required",
      },
      503,
    );
  if (request.method === "GET") return reply(connections.snapshot());
  try {
    const value = await body(request);
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    const action = value.action;
    if (action === "test") {
      const b = exactObject(value, ["action", "endpoint", "credentials"]);
      validateDirectEndpoint(b.endpoint);
      validateDirectCredentials(b.credentials);
      return reply(
        await connections.test(b.endpoint, b.credentials, request.signal),
      );
    }
    if (action === "connect") {
      const extra =
        Object.hasOwn(value, "connectionId") ||
        Object.hasOwn(value, "generation");
      const b = exactObject(value, [
        "action",
        "name",
        "receipt",
        "create",
        ...(extra ? ["connectionId", "generation"] : []),
      ]);
      name(b.name);
      uuid(b.receipt);
      if (typeof b.create !== "boolean") invalid();
      if (extra) {
        uuid(b.connectionId);
        uuid(b.generation);
      }
      return reply(
        await connections.connect({
          name: b.name,
          receipt: b.receipt,
          create: b.create as boolean,
          ...(extra
            ? {
                connectionId: b.connectionId as string,
                generation: b.generation as string,
              }
            : {}),
        }),
      );
    }
    if (
      action === "rename" ||
      action === "enable" ||
      action === "disconnect" ||
      action === "sync"
    ) {
      const b = exactObject(value, [
        "action",
        "id",
        "generation",
        ...(action === "rename"
          ? ["name"]
          : action === "enable"
            ? ["enabled"]
            : []),
      ]);
      uuid(b.id);
      uuid(b.generation);
      if (action === "rename") {
        name(b.name);
        return reply(await connections.rename(b.id, b.generation, b.name));
      }
      if (action === "enable") {
        if (typeof b.enabled !== "boolean") invalid();
        return reply(
          await connections.enable(b.id, b.generation, b.enabled as boolean),
        );
      }
      if (action === "disconnect")
        return reply(await connections.disconnect(b.id, b.generation));
      return reply(await connections.sync(b.id, b.generation));
    }
    invalid();
  } catch (error) {
    const code = directConnectionCode(error);
    const status =
      code === "invalid-input"
        ? 400
        : [
              "stale-generation",
              "receipt-expired",
              "destination-busy",
              "recovery-required",
              "bounds-exceeded",
              "identity-changed",
            ].includes(code)
          ? 409
          : 503;
    return reply(
      {
        error:
          "Direct SMB operation unavailable. Check the selected destination or preserve its original pending operation for recovery.",
        code,
      },
      status,
    );
  }
}
