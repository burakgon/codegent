import { encodeEnvelope, decodeEnvelope, type DomainEvent } from "@codegent/protocol";

// Chunked, not `String.fromCharCode(...b)`: the daemon's first `term` frame
// after `sub` is a full ring snapshot (up to 200KB), and spreading that many
// arguments overflows the call stack (engine/stack-depth dependent — well
// inside browser failure territory at snapshot size).
export const bytesToB64 = (b: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
};
export const b64ToBytes = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// Always same-origin: vite dev proxies /api and /ws to the daemon (see
// vite.config.ts); in prod the daemon serves the built UI itself. A hardcoded
// daemon origin would be a cross-origin fetch, and the daemon sends no CORS
// headers by design.
export const baseUrl = "";
export const token = () => (typeof localStorage !== "undefined" ? localStorage.getItem("cgToken") ?? "" : "");

const H = () => ({ "x-codegent-token": token(), "content-type": "application/json" });

// A failed response must throw, never silently no-op: the daemon reports
// errors as { error } json — surface that text, else "<status> <statusText>".
const check = async (res: Response): Promise<Response> => {
  if (res.ok) return res;
  let msg = "";
  try {
    const b: any = await res.json();
    if (typeof b?.error === "string") msg = b.error;
  } catch { /* non-json error body */ }
  throw new Error(msg || `${res.status} ${res.statusText}`);
};

export const api = {
  get: async <T>(p: string): Promise<T> => (await check(await fetch(baseUrl + p, { headers: H() }))).json(),
  post: async <T>(p: string, body: unknown): Promise<T> => (await check(await fetch(baseUrl + p, { method: "POST", headers: H(), body: JSON.stringify(body) }))).json(),
  patch: async <T>(p: string, body: unknown): Promise<T> => (await check(await fetch(baseUrl + p, { method: "PATCH", headers: H(), body: JSON.stringify(body) }))).json(),
  del: async (p: string): Promise<void> => { await check(await fetch(baseUrl + p, { method: "DELETE", headers: H() })); },
};

export type CgSocket = {
  sub(sid: string, onData: (bytes: Uint8Array) => void): () => void;
  input(sid: string, bytes: Uint8Array): void;
  resize(sid: string, cols: number, rows: number): void;
  close(): void;
};

export function connectWs(onEvent: (e: DomainEvent) => void): CgSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?t=${token()}`);
  const handlers = new Map<string, (b: Uint8Array) => void>();
  const queue: string[] = [];
  const send = (s: string) => (ws.readyState === WebSocket.OPEN ? ws.send(s) : queue.push(s));
  ws.onopen = () => queue.splice(0).forEach(s => ws.send(s));
  ws.onmessage = m => {
    const env = decodeEnvelope(String(m.data));
    if (env.ch === "event") onEvent(env.ev);
    else if (env.ch === "term") handlers.get(env.sid)?.(b64ToBytes(env.data));
  };
  return {
    sub(sid, onData) {
      handlers.set(sid, onData);
      send(encodeEnvelope({ ch: "sub", sid }));
      return () => { handlers.delete(sid); send(encodeEnvelope({ ch: "unsub", sid })); };
    },
    input: (sid, bytes) => send(encodeEnvelope({ ch: "input", sid, data: bytesToB64(bytes) })),
    resize: (sid, cols, rows) => send(encodeEnvelope({ ch: "resize", sid, cols, rows })),
    close: () => ws.close(),
  };
}
