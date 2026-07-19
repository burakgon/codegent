import { test, expect, afterAll } from "bun:test";
import { openDb } from "../src/store/db";
import { PtyManager } from "../src/pty/manager";
import { startServer } from "../src/http/server";
import { decodeEnvelope, encodeEnvelope } from "@codegent/protocol";

const db = openDb(":memory:");
const dataDir = `/tmp/cg-http-${crypto.randomUUID()}`;
const ptys = new PtyManager(db, dataDir);
const cfg = { port: 4790 + Math.floor(Math.random() * 100), dataDir, token: "testtoken" };
const srv = startServer(cfg, db, ptys);
const base = `${srv.url}api`;
const T = { headers: { "x-codegent-token": "testtoken", "content-type": "application/json" } };

afterAll(() => srv.stop());

test("auth required", async () => {
  const r = await fetch(`${base}/projects`);
  expect(r.status).toBe(401);
  const w = await fetch(`${srv.url}ws`);
  expect(w.status).toBe(401);
});

test("project + card REST roundtrip + ws event", async () => {
  const ws = new WebSocket(`${srv.url.replace("http", "ws")}ws?t=testtoken`);
  const events: any[] = [];
  ws.onmessage = m => { const e = decodeEnvelope(String(m.data)); if (e.ch === "event") events.push(e.ev); };
  await new Promise(r => (ws.onopen = r));

  const p = await (await fetch(`${base}/projects`, { ...T, method: "POST", body: JSON.stringify({ name: "X", path: "/tmp", baseBranch: "main", skipGitCheck: true }) })).json();
  const c = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "hello", body: "", agent: "none" }) })).json();
  expect(c.phase).toBe("queued");
  const moved = await (await fetch(`${base}/cards/${c.id}`, { ...T, method: "PATCH", body: JSON.stringify({ phase: "working" }) })).json();
  expect(moved.phase).toBe("working");
  // symbols-only worktree name must be rejected at the API boundary, not by git
  const bad = await fetch(`${base}/projects/${p.id}/worktrees`, { ...T, method: "POST", body: JSON.stringify({ name: "###" }) });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toBe("invalid name");
  await Bun.sleep(200);
  expect(events.some(e => e.t === "card" && e.card.phase === "working")).toBe(true);
  ws.close();
}, 15000);

test("protocol-invalid bodies 400 at the boundary; valid ones still flow", async () => {
  const p = await (await fetch(`${base}/projects`, { ...T, method: "POST", body: JSON.stringify({ name: "V", path: "/tmp", baseBranch: "main", skipGitCheck: true }) })).json();
  const c = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "boundary" }) })).json();
  expect(c.phase).toBe("queued");

  // invalid agent on create → 400
  const badAgent = await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "x", agent: "gpt" }) });
  expect(badAgent.status).toBe(400);
  expect((await badAgent.json()).error).toContain("agent");

  // invalid phase on PATCH → 400 and NOT persisted (was: 200 + a card the
  // protocol rejects, silently dropped from the ws fan-out → tab desync)
  const badPhase = await fetch(`${base}/cards/${c.id}`, { ...T, method: "PATCH", body: JSON.stringify({ phase: "flying" }) });
  expect(badPhase.status).toBe(400);
  expect((await badPhase.json()).error).toContain("phase");
  const cards = await (await fetch(`${base}/projects/${p.id}/cards`, T)).json();
  expect(cards.find((k: any) => k.id === c.id).phase).toBe("queued");

  // a valid PATCH still 200s and still fans out as a ws event
  const ws = new WebSocket(`${srv.url.replace("http", "ws")}ws?t=testtoken`);
  const events: any[] = [];
  ws.onmessage = m => { const e = decodeEnvelope(String(m.data)); if (e.ch === "event") events.push(e.ev); };
  await new Promise(r => (ws.onopen = r));
  const ok = await fetch(`${base}/cards/${c.id}`, { ...T, method: "PATCH", body: JSON.stringify({ phase: "review" }) });
  expect(ok.status).toBe(200);
  expect((await ok.json()).phase).toBe("review");
  await Bun.sleep(200);
  expect(events.some(e => e.t === "card" && e.card.id === c.id && e.card.phase === "review")).toBe(true);
  ws.close();
}, 15000);

test('PATCH with v0.1 phase "waiting" → 400, card unchanged', async () => {
  const p = await (await fetch(`${base}/projects`, { ...T, method: "POST", body: JSON.stringify({ name: "W", path: "/tmp", baseBranch: "main", skipGitCheck: true }) })).json();
  const c = await (await fetch(`${base}/projects/${p.id}/cards`, { ...T, method: "POST", body: JSON.stringify({ title: "legacy" }) })).json();
  const r = await fetch(`${base}/cards/${c.id}`, { ...T, method: "PATCH", body: JSON.stringify({ phase: "waiting" }) });
  expect(r.status).toBe(400);
  expect((await r.json()).error).toContain("phase");
  const cards = await (await fetch(`${base}/projects/${p.id}/cards`, T)).json();
  expect(cards.find((k: any) => k.id === c.id).phase).toBe("queued");
}, 15000);

test("POST under a ghost project → 404 project not found, all three routes", async () => {
  // Valid bodies on purpose: the failure must be the missing project (404),
  // never body validation (400) — and the cards FK 500 must be gone.
  const routes: Array<[string, unknown]> = [
    ["cards", { title: "x" }],
    ["sessions", { title: "x" }],
    ["worktrees", { name: "x" }],
  ];
  for (const [route, body] of routes) {
    const r = await fetch(`${base}/projects/ghost/${route}`, { ...T, method: "POST", body: JSON.stringify(body) });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("project not found");
  }
}, 15000);

test("POST sessions on a real project still opens a shell (cwd falls back to project path)", async () => {
  const p = await (await fetch(`${base}/projects`, { ...T, method: "POST", body: JSON.stringify({ name: "S", path: "/tmp", baseBranch: "main", skipGitCheck: true }) })).json();
  const r = await fetch(`${base}/projects/${p.id}/sessions`, { ...T, method: "POST", body: JSON.stringify({}) });
  expect(r.status).toBe(201);
  const meta = await r.json();
  expect(meta.kind).toBe("shell");
  expect(meta.cwd).toBe("/tmp");
  await fetch(`${base}/sessions/${meta.id}`, { ...T, method: "DELETE" });
}, 15000);

test("terminal over ws: snapshot then live", async () => {
  const meta = ptys.open({ projectId: "p", cwd: "/tmp", title: "t" });
  const ws = new WebSocket(`${srv.url.replace("http", "ws")}ws?t=testtoken`);
  const frames: string[] = [];
  ws.onmessage = m => { const e = decodeEnvelope(String(m.data)); if (e.ch === "term" && e.sid === meta.id) frames.push(Buffer.from(e.data, "base64").toString()); };
  await new Promise(r => (ws.onopen = r));
  ws.send(encodeEnvelope({ ch: "sub", sid: meta.id }));
  await Bun.sleep(300);
  ws.send(encodeEnvelope({ ch: "input", sid: meta.id, data: Buffer.from("printf 'WS_OK\\n'\r").toString("base64") }));
  await Bun.sleep(700);
  expect(frames.join("")).toContain("WS_OK");
  ws.close(); ptys.close(meta.id);
}, 20000);
