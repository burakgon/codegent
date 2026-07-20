# codegent v0.3 Part 2 — Zero-Knowledge Relay, Device Pairing & Web Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **v0.3 is written as a just-in-time SEQUENCE (spec §16), one plan per independent subsystem.** This is Part 2 of 4:
> - Part 1: Universal terminal-state tier — daemon-only detection, silent-wedge closure, mark-state override, and watchdog.
> - **Part 2 (this plan): Zero-knowledge relay + device pairing + Web Push** — outbound-only remote access, authenticated E2E device sessions, signed remote UI, direct notifications, and opportunistic LAN-direct.
> - Part 3: Review queue + diff view + stale cascade + Send-back + PR tracking.
> - Part 4: Installer + `npx codegent-cli` + service + first-run + Settings (+ CI provisioning and final package layout).
> Parts 3-4 are written just-in-time, folding in Parts 1-2's findings.

**Goal:** A browser can pair with a daemon, operate the existing codegent API/terminal surface remotely without opening an inbound daemon port, and receive content-minimal Web Push when attention is required. The hosted or self-hosted relay routes opaque bytes only: it learns routing device IDs, frame sizes, and timing, but never terminal/application content or plaintext application-control metadata (spec §10; `docs/research/sshx-relay-e2e.md` §§1.5-1.6, 8(b), 8(d)).

**Architecture:** Keep the current localhost HTTP + `/ws` path as the direct transport. Add a second browser transport that establishes an authenticated browser⇆daemon session through two outbound WSS legs, then carries API RPC, domain events, terminal subscriptions/output/input, pairing events, and encrypted WebRTC signaling inside one `crypto_secretstream_xchacha20poly1305` stream per direction. Long-term X25519 device keys authenticate fresh ephemeral X25519 connection keys; the fragment pairing capability authenticates first contact and pins the daemon key. The relay parses only the minimal outer routing envelope. Web Push is a separate daemon→browser-push-service HTTPS path and never enters the relay (`apps/daemon/src/http/ws.ts`, `apps/web/src/{api,wsCore}.ts`; spec §§3, 9.2, 10-11; research §§1.6, 2.3-2.4, 7-8).

**Tech Stack:** Existing Bun + TypeScript + React/Vite monorepo; a new `@codegent/crypto` workspace over official libsodium bindings selected by Task 1; strict Zod relay schemas in `@codegent/protocol`; Bun relay binary; standard Web Push/VAPID through a maintained library; browser `RTCPeerConnection` plus a Bun-compatible WebRTC DataChannel implementation selected latest-stable at execution. Candidate packages are resolved, licensed, and runtime-proved rather than pinned in this draft (spec principle 7; Task 1).

**Citation shorthand:** Every `research §…` reference below means `docs/research/sshx-relay-e2e.md §…`; every `spec §…` reference means `docs/superpowers/specs/2026-07-19-codegent-design.md §…`.

## Global Constraints

- **Crypto is study-first and safety-critical.** Use only documented libsodium recipes and primitives, official constants, committed interoperability vectors, and negative/tamper vectors. No bespoke cipher, KDF, nonce scheme, or home-grown “almost Noise” construction. The authenticated transcript composition is frozen only after Task 1 proves it and records it; later tasks **adapt to spike findings** (`docs/research/sshx-relay-e2e.md` §§1.6, 8(a); spec §10 and study-first rule in §3).
- **Keep the crypto fork.** X25519/`crypto_kx` directional keys + transcript authentication + exactly one `crypto_secretstream_xchacha20poly1305` per direction. Do NOT adopt sshx's Argon2/AES-CTR verifier/cipher, do NOT double-wrap secretstream frames in standalone AEAD, and do NOT treat raw unauthenticated X25519 as sufficient (`docs/research/sshx-relay-e2e.md` §§1.2-1.6, 8(a); spec §10).
- **Latest stable at execution time.** Resolve every candidate with `bun pm view <pkg> version` immediately before adoption and record selected versions/licenses in the Task-1 findings. Browser candidates: `libsodium-wrappers` and `libsodium-wrappers-sumo`; daemon candidates: `sodium-native` and the official wrapper fallback. The chosen runtime must expose `crypto_kx_client_session_keys`, `crypto_kx_server_session_keys`, and `crypto_secretstream_xchacha20poly1305_{init_push,init_pull,push,pull}`. `node:crypto` is not a production crypto backend because it does not expose libsodium's `crypto_kx` recipe or `crypto_secretstream` (spec principle 7; research §1.6).
- **Honest-but-curious relay boundary.** The relay may inspect only protocol version/routing necessities (route/device IDs, connection ID), opaque payload length, timing, and separately authenticated relay-policy frames. Project/card/session IDs, API paths, terminal SIDs/offsets, event kinds, device labels, errors, SDP/ICE, and all other semantic fields stay inside authenticated encryption. The relay never stores content snapshots and never logs payload bytes (`docs/research/sshx-relay-e2e.md` §§1.5, 2.2-2.4, 4.2, 8(b)-8(d); spec §10).
- **No unsafe dead-link queuing.** PTY input and mutating API actions are accepted only by an established authenticated transport; they are never silently queued across an outage or auto-replayed after an ambiguous send. Output/state are resumable from daemon-owned bounded history. Slow consumers disconnect and resume rather than silently losing holes (`docs/research/sshx-relay-e2e.md` §§2.3-2.4, 4.3; spec §9.2).
- **Push is content-minimal and relay-independent.** Exactly three application push kinds — `waiting-for-input`, `error`, `review-ready` — and exactly four payload fields — `project`, `taskTitle`, `kind`, `elapsed`. Question and permission map to the same waiting kind; `silent`, running, pairing, and ordinary activity never push. The daemon sends standard encrypted Web Push directly to each push-service endpoint; no relay module is in that call graph (`docs/research/sshx-relay-e2e.md` §7; spec §11).
- **Localhost-direct remains first-class.** `http://127.0.0.1:<port>` + authenticated `/api` + `/ws` behavior stays available and does not round-trip through the relay. Remote relay transport is an alternative implementation behind a shared browser transport interface, not a replacement (`apps/daemon/src/http/ws.ts`, `apps/web/src/{api,wsCore}.ts`; spec §3).
- Daemon remains loopback-bound for inbound HTTP/WS and opens one outbound WSS relay connection; no port forwarding, UPnP, public daemon bind, or inbound LAN listener is introduced (spec §§3, 10; research §3.1).
- Relay queues and handoffs are bounded, frame-size checked, backpressure-aware, and observable. Default product policy remains “unlimited,” but safety resource bounds are always enforced; overflow closes the slow leg and relies on resume (`docs/research/sshx-relay-e2e.md` §§2.4, 4.1, 8(b)-8(c); spec §10).
- UI grammar: font sizes 9.5/10/11/12/13; weights 400/500 (650 tiny-caps only); radii 6/8/999; `var(--…)` tokens; English; inline-SVG icons; no emoji. Pairing/notification additions obey the same grammar as Part 1.
- Suite entry: bare `bun test` green from root; `bun run typecheck` exit 0; `cd apps/web && bunx vite build` green; relay compiled-binary and Docker smoke checks green. Run task-focused tests during each task and the complete suite before each task commit.
- Browser/device live flows are deliberately deferred to the Part-2 gate (Task 15): SONNET driver + Chrome DevTools MCP, evidence PNGs/report under `.superpowers/sdd/`. **Task 1 is the sole exception:** its hard gate requires a real Chrome crypto round-trip before any dependent work begins.
- Commits: plain conventional messages, **NO attribution of any kind** (no Co-authored-by, no AI/Codex/Claude mentions), author burakgon only. Nothing under `.superpowers/` is committed.
- Branching: Part 2 lands on its **own branch** created from the controller-designated v0.3 integration line after Part 1 is merged; it does not continue on Part 1's branch. When the Part-2 gate is green, merge that branch back to the v0.3 line. Implementers never merge/rebase unrelated in-flight work implicitly.

## Part Boundary and Draft Assumptions

- **In this part:** authenticated crypto/runtime proof; relay wire protocol; opaque router/owner proxy; daemon and browser relay transports; pairing/revoke/confirmation/link rotation; signed UI manifest/bootstrap; Web Push; opportunistic LAN-direct; relay Docker/self-host parity; threat-model/live gate.
- **Later:** Part 3 consumes the transport for review/diff but does not alter E2E framing. Part 4 expands the minimal pairing controls into the complete first-run/Settings experience, installer/CLI surface, release CI, and service management.
- **Resolved decision A — bootstrap trust:** hosted pairing URLs redirect (without ever receiving the fragment) to a separately deployed, versioned publisher bootstrap whose Ed25519 verification key is compiled in outside the mutable relay response. The relay serves signed manifest/assets only. A first-load bootstrap freshly supplied by the same relay is forbidden because it is not a pin (`docs/research/sshx-relay-e2e.md` §7; spec §10). **Resolved (controller, 2026-07-20):** the independent publisher origin is a dedicated host distinct from the relay — default `app.codegent.io` (Cloudflare Pages/Worker serving immutable, hash-addressed assets + the signed manifest), separate from `relay.codegent.io`. The pinned Ed25519 verification key is compiled into the published bootstrap at release time and signed with an offline key held outside git/relay/daemon; the relay only issues the fragment-blind redirect and never serves the app shell. Same-operator hosting is acceptable because trust rests on the offline-signed immutable pin, not on origin ownership. Task 8 implements the verifier independent of the exact origin, so no task is blocked; the `app.codegent.io` subdomain is provisioned at Part-2 deploy.
- **Resolved decision B — strict push contract governs:** spec §11's explicit "exactly three push kinds" wins. Relay-connection loss and reconnect-digest information stay IN-APP (UI indicators when the app is open) and never Web Push; §9.2's connection-awareness is satisfied by in-app state, not a push. No fourth push kind and no hidden payload identifier. The strict 3-kind / 4-field `PushPayload` (Task 11) is authoritative.

## File Structure (new / modified)

```
packages/crypto/                         # NEW workspace: runtime ports, authenticated handshake, secretstream
  src/{index,types,handshake,secretstream}.ts
  src/runtime/{browser,daemon}.ts        # selected/adapted from Task-1 findings
  test/{handshake,interop,secretstream}.test.ts
  test/fixtures/interop-v1.json          # committed daemon⇆browser vectors, test-only keys
packages/protocol/src/relay.ts           # NEW: outer/handshake/secure frames + signed UI manifest schemas/codecs
packages/protocol/src/notifications.ts   # NEW: strict 3-kind / 4-field PushPayload
packages/protocol/src/index.ts           # MOD: exports
apps/relay/                              # NEW Bun app / single relay binary
  src/{index,server,router,queue,owner,proxy,policy}.ts
  test/{router,queue,owner-proxy,zero-knowledge}.test.ts
  package.json
  Dockerfile
apps/daemon/src/relay/
  {client,peer-session,replay,pairing,device-store}.ts  # NEW: outbound WSS + E2E peers + device lifecycle
apps/daemon/src/push/{service,payload,store}.ts          # NEW: VAPID + direct push delivery
apps/daemon/src/http/{server,ws,api-handler}.ts          # MOD/NEW: reusable local/remote application dispatch
apps/daemon/src/{config,index}.ts                        # MOD: identity, relay/push lifecycle wiring
apps/daemon/src/store/db.ts                              # MOD: paired devices/tickets/subscriptions migrations
apps/web/src/transport/{types,local,relay,reconcile}.ts  # NEW: transport split; localhost remains direct
apps/web/src/pairing/{credential,device-store,controller}.ts # NEW: fragment + IndexedDB device identity
apps/web/src/push/{register,service-worker}.ts           # NEW: contextual permission + push display/click
apps/web/src/bootstrap/{bootstrap,verify-manifest}.ts    # NEW: pinned-key manifest/asset verification
apps/web/src/components/{Shell,PairingPanel}.tsx         # MOD/NEW: minimal Part-2 pairing/device controls
apps/web/src/{api,wsCore}.ts + main.tsx                   # MOD: shared transport selection/wiring
scripts/sign-ui-manifest.ts                              # NEW: release-only manifest/hash/sign step
deploy/relay/{Caddyfile.example,compose.yaml}             # NEW: same-image self-host examples
docs/security/relay-threat-model.md                      # NEW: honest-but-curious boundary and bootstrap caveat
docs/self-host-relay.md                                  # NEW: same binary/image deployment
```

---

### Task 1: HARD GATE — libsodium runtime interoperability + authenticated transcript spike

**Why a gate:** Every later task assumes identical `crypto_kx`, transcript-MAC, and `crypto_secretstream_xchacha20poly1305` behavior in the Bun daemon and real browser. `crypto_kx` explicitly assumes the peer public key is known; raw key exchange through the relay is MITM-able. This task proves runtime/package viability and the authenticated transcript before production code exists (spec §10; `docs/research/sshx-relay-e2e.md` §§1.6, 8(a); official libsodium key-exchange/secretstream recipes cited by that research).

**Files:**
- Create: `packages/crypto/spike/{daemon,browser,vector}.ts`, `apps/web/spike/crypto.html`, `packages/crypto/test/fixtures/interop-v1.json`, `docs/research/crypto-runtime-spike.md`
- Modify: workspace/package manifests only as needed for the throwaway spike

**Interfaces / construction to prove:**
- Fixed roles: browser = `crypto_kx` client; daemon = server. Each has a long-term X25519 device key and a fresh ephemeral X25519 key per connection.
- Canonical full transcript `HandshakeTranscriptV1 = [domain, protocolVersion, mode, daemonRouteId, daemonDeviceId, browserDeviceId, connectionEpoch, browserStaticPk, daemonStaticPk, browserEphemeralPk, daemonEphemeralPk, browserNonce, daemonNonce, browserTxHeader, daemonTxHeader]`. Encode a fixed-order tuple to bytes; never MAC ad-hoc object JSON. The server-hello proof covers a separately domain-labeled fixed-order prefix ending at `daemonTxHeader`; client-finish and server-finish proofs cover the full transcript. No application frame is accepted before the full-transcript server finish and mutual encrypted ready.
- First pair: a random 32-byte fragment capability authenticates the prefix/full directional proofs; static `crypto_kx` directional keys add proof-of-possession for both long-term device keys. Reconnect: already-pinned static `crypto_kx` directional keys authenticate the same staged transcript. Fresh ephemeral `crypto_kx` directional keys feed secretstream. Both peers exchange an encrypted `ready(fullTranscriptHash)` before a ticket is consumed/device is persisted. This binds version, roles, IDs, both static and ephemeral keys, epoch, nonces, and both stream headers; it blocks relay key substitution and gives session forward secrecy. **The exact proof order/encoding is adapted if the spike finds an official safer recipe, but the bound fields, domain separation, and mutual key confirmation may not be weakened** (research §§1.6, 8(a); spec §10).
- Test-vector contract: fixed test-only seeds/keys + transcript + directional session keys + MACs + both secretstream headers/ciphertexts/tags in `interop-v1.json`; `daemon encrypts → browser decrypts` and `browser encrypts → daemon decrypts` with identical plaintext bytes. A live in-memory exchange additionally lets each runtime originate its own random header.

- [ ] **Step 1: Resolve latest-stable package matrix.** Run `bun pm view {libsodium-wrappers,libsodium-wrappers-sumo,sodium-native} version`; record version, license, API presence, bundle size, types, initialization, Bun support, Vite/Chrome support, and compiled-daemon behavior. Directly invoke `crypto_kx_client_session_keys` in the browser role, `crypto_kx_server_session_keys` in the daemon role, and `crypto_secretstream_xchacha20poly1305_{init_push,init_pull,push,pull}` in both. Standard `libsodium-wrappers` is tested before sumo because its official API currently includes the required KX/auth/secretstream surface; choose sumo only if the required API/build proves missing. Test `sodium-native` first for the daemon; if Bun N-API or `bun build --compile` packaging fails, select the official WASM wrapper for both runtimes. Reject `node:crypto` as the production backend rather than recreating `crypto_kx`/secretstream.
- [ ] **Step 2: Write the failing cross-runtime harness and vector reader.** Assert both runtimes derive `browser.rx === daemon.tx` and `browser.tx === daemon.rx`; assert both decrypt the committed opposite-direction fixture; assert byte-for-byte round trips for empty, UTF-8, binary/NUL, 64 KiB, `TAG_REKEY`, and `TAG_FINAL` messages.
- [ ] **Step 3: Prove the authenticated transcript.** Implement only enough spike code for pairing and reconnect proof exchange. Negative cases must fail closed: swapped roles, changed protocol version, substituted static or ephemeral key, changed device ID/epoch/nonce/header, bad proof, unknown/revoked browser key, replayed old epoch, and reused/expired pairing capability. Assert the browser pins the daemon static key only after the capability + daemon proof verifies; assert the daemon persists the browser only after both encrypted `ready` frames.
- [ ] **Step 4: Run in BOTH target runtimes.** Daemon side runs under Bun and as a throwaway `bun build --compile` artifact on the current architecture. Browser side runs from a Vite build in real Chrome (not Bun pretending to be a browser), including WASM/CSP loading. Execute daemon→Chrome→daemon over a loopback harness and write exact commands/results to the findings doc.
- [ ] **Step 5: Record the gate.** `docs/research/crypto-runtime-spike.md` names selected packages/versions, exposes the final byte-level transcript/proof sequence, records vector hashes and bundle/compile results, and states one verdict. **PASS = the selected stack round-trips E2E in Bun + compiled daemon + real browser in both directions with the shared vector, and all transcript/tamper cases fail closed. FAIL = STOP all Tasks 2-15 and escalate to the controller; do not substitute custom crypto.**
- [ ] **Step 6: Commit** — `chore: prove cross-runtime libsodium handshake and secretstream gate`

---

### Task 2: Relay protocol schemas and canonical wire codecs

**Files:**
- Create: `packages/protocol/src/relay.ts`
- Modify: `packages/protocol/src/index.ts`, `packages/protocol/package.json`
- Test: `packages/protocol/test/relay.test.ts`

**Interfaces:**

```ts
type RelayOuterFrame = {
  v: 1; connectionId: string; sourceDeviceId: string;
  destinationDeviceId: string; payload: Uint8Array;
};
type RelayPolicyFrame = {
  v: 1; connectionId: string; signedPayload: Uint8Array; signature: Uint8Array;
}; // reserved; no v0.3 product-policy emission

type HandshakeFrame =
  | { t: "client-hello"; mode: "pair" | "resume"; epoch: string; browserDeviceId: string;
      browserStaticPk: Uint8Array; browserEphemeralPk: Uint8Array; browserNonce: Uint8Array }
  | { t: "server-hello"; daemonDeviceId: string; daemonStaticPk: Uint8Array;
      daemonEphemeralPk: Uint8Array; daemonNonce: Uint8Array; daemonTxHeader: Uint8Array;
      capabilityPrefixProof?: Uint8Array; staticPrefixProof: Uint8Array }
  | { t: "client-finish"; browserTxHeader: Uint8Array;
      capabilityFullProof?: Uint8Array; staticFullProof: Uint8Array }
  | { t: "server-finish"; capabilityFullProof?: Uint8Array; staticFullProof: Uint8Array };

type SecureAppFrame = { epoch: string; seq: number; body: AppBody };
type AppBody =
  | { t: "rpc.req"; requestId: string; method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: unknown }
  | { t: "rpc.res"; requestId: string; status: number; body?: unknown }
  | { t: "event"; eventSeq: number; event: DomainEvent }
  | { t: "term.subscribe"; sid: string; afterByteSeq: number }
  | { t: "term.chunk"; sid: string; byteSeq: number; bytes: Uint8Array }
  | { t: "term.reset"; sid: string; baseByteSeq: number; snapshot: Uint8Array }
  | { t: "term.input"; sid: string; commandId: string; bytes: Uint8Array }
  | { t: "term.resize"; sid: string; commandId: string; cols: number; rows: number }
  | { t: "sync"; eventsThrough: number; terminals: Record<string, number> }
  | { t: "ack"; commandId: string }
  | { t: "device.paired"; device: PairedDeviceSummary }
  | { t: "webrtc.signal"; negotiationId: string; signal: RtcSignal }
  | { t: "ready"; transcriptHash: Uint8Array };

type UiManifestPayload = {
  schemaVersion: 1; release: string; protocolVersion: 1; rollbackCounter: number;
  entrypoint: string; assets: Array<{ path: string; sha256: string; bytes: number; mediaType: string }>;
};
type SignedUiManifest = { payload: Uint8Array; signature: Uint8Array };
```

All integers are non-negative safe integers; IDs and paths have explicit length/character caps; RPC paths must begin `/api/`; frames are strict and reject unknown fields. A canonical binary codec (selected latest-stable; prefer the researched CBOR shape) encodes inner frames, while the relay imports only the outer/policy codec. All semantic fields above remain in `payload` and are never decoded by `apps/relay` (spec §10; research §§2.2-2.4, 8(b)). Signed-manifest signatures cover the exact `payload` bytes, avoiding JSON canonicalization ambiguity (spec §10; research §7).

- [ ] **Step 1: failing schema/codec tests** — every variant round-trips binary bytes; malformed lengths/IDs/paths/unsafe integers/extra fields reject; protocol-version mismatch rejects; a binary terminal fixture preserves every byte; the signed manifest parses only after its exact payload bytes are decoded.
- [ ] **Step 2: privacy-boundary tests** — prove `RelayOuterFrame` contains only routing fields + opaque bytes; add a source/import assertion that the relay-facing entrypoint cannot import handshake/AppBody decoders; scan an encoded outer fixture for known project/title/SID/API-path strings and find none.
- [ ] **Step 3: implement strict codecs** — adapt exact function names/constant sizes to Task-1 findings; export `encode/decodeRelayOuter`, `encode/decodeHandshake`, `encode/decodeSecureApp`, and `decodeUiManifestPayload` from separate sub-entrypoints so the relay can depend on outer-only code.
- [ ] **Step 4: green + full suite/typecheck.**
- [ ] **Step 5: Commit** — `feat: define opaque relay and signed-manifest protocol`

---

### Task 3: Shared `@codegent/crypto` handshake + secretstream package

**Files:**
- Create: `packages/crypto/{package.json,tsconfig.json}`, `packages/crypto/src/{index,types,handshake,secretstream}.ts`, `packages/crypto/src/runtime/{browser,daemon}.ts`
- Test: `packages/crypto/test/{handshake,interop,secretstream}.test.ts`; retain `test/fixtures/interop-v1.json`
- Modify: root/workspace lockfile; `apps/{daemon,web}/package.json`

**Interfaces:**

```ts
type DeviceKeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };
type SessionKeys = { rx: Uint8Array; tx: Uint8Array };
type PairingAuth = { mode: "pair"; capability: Uint8Array };
type ResumeAuth = { mode: "resume"; expectedPeerKey: Uint8Array };

interface CryptoRuntime {
  ready(): Promise<void>;
  keypair(seed?: Uint8Array): DeviceKeyPair;
  clientSessionKeys(self: DeviceKeyPair, serverPk: Uint8Array): SessionKeys;
  serverSessionKeys(self: DeviceKeyPair, clientPk: Uint8Array): SessionKeys;
  auth(message: Uint8Array, key: Uint8Array): Uint8Array;
  verifyAuth(tag: Uint8Array, message: Uint8Array, key: Uint8Array): boolean;
  hash(message: Uint8Array): Uint8Array; // documented crypto_generichash for transcript hash/fingerprint
  memzero(bytes: Uint8Array): void;
}

type HandshakeResult = { peerDeviceId: string; peerStaticKey: Uint8Array; epoch: string; channel: SecureChannel };
interface SecureChannel {
  push(frame: Uint8Array, tag?: "message" | "rekey" | "final"): Uint8Array;
  pull(ciphertext: Uint8Array): { message: Uint8Array; tag: "message" | "rekey" | "final" };
  close(): void;
}
```

Implement the Task-1-proven transcript/proof state machines with fixed browser-client/daemon-server roles. Long-term static KX keys authenticate fresh ephemeral KX keys; fragment capability additionally authenticates first pairing; ephemeral `tx/rx` initialize one secretstream per direction. No second AEAD layer exists. Keys/proofs are compared using libsodium verification and transient secret/capability/ephemeral buffers are zeroed on success and every error path (`docs/research/sshx-relay-e2e.md` §§1.6, 8(a); spec §10). **Adapt runtime imports, allocation, and exact return shapes to spike findings.**

- [ ] **Step 1: failing handshake-state tests** — legal message order succeeds once; out-of-order/duplicate messages, wrong role/mode, unknown peer, revoked key, bad capability/static proof, changed transcript field, and old epoch fail closed and destroy state.
- [ ] **Step 2: failing secretstream tests** — both fixture directions decrypt; modification/removal/duplication/reordering/wrong-header fail; `REKEY` and `FINAL` work; post-final push/pull rejects; assert there is one ciphertext expansion only (secretstream `ABYTES`, no nested AEAD).
- [ ] **Step 3: implement runtime ports + state machines** — selected browser backend and daemon backend expose the same high-level API; isolate native Buffer allocation differences inside the daemon adapter; never leak backend-specific state into protocol/app code.
- [ ] **Step 4: interoperability + memory hygiene** — rerun the Task-1 vector through production package exports; failure tests assert `memzero`/state disposal; Vite build and compiled-daemon smoke remain green.
- [ ] **Step 5: Commit** — `feat: add authenticated device handshake and secretstream package`

---

### Task 4: Relay binary — opaque single-node router + bounded queues

**Files:**
- Create: `apps/relay/{package.json,tsconfig.json}`, `apps/relay/src/{index,server,router,queue,policy}.ts`
- Test: `apps/relay/test/{router,queue,zero-knowledge}.test.ts`
- Modify: root package scripts/typecheck workspace

**Interfaces:**
- WSS endpoints: daemon attaches outbound at `/v1/connect/daemon/:daemonDeviceId` with its stable routing-only claim secret in the Authorization header; relay accepts it only when `base64url(SHA-256(routeClaimSecret)) === :daemonDeviceId`, using constant-time comparison and never logging the secret. Browser attaches at `/v1/connect/device/:daemonDeviceId/:browserDeviceId`; `/d/:daemonDeviceId` is the no-secret pairing/bootstrap entry route; `/healthz` is readiness. This stateless claim prevents a browser that knows the public route ID from impersonating the daemon without creating an account or reusing any X25519/pairing secret. The fragment is absent from every request by construction and must never be copied into query/header/frame fields (spec §10; research §§1.1, 3.1, 8(d)).
- `class OpaqueRouter { attachDaemon(route, socket): Detach; attachDevice(route, socket): Detach; route(frame: RelayOuterFrame): RouteResult }` and `class BoundedByteQueue { push(frame): "ok"|"overflow"; drain(send): Promise<void> }`.
- Safety bounds: max 64 KiB plaintext application chunks, an outer-frame ceiling derived from codec + secretstream overhead, max 64 queued frames and 4 MiB queued bytes per live handoff; overflow closes the slow leg with a resumable transport error, never drops silently. Record/adjust the two derived byte ceilings with tests, not guesswork. These adopt sshx's 64-message/64-KiB mechanics while replacing its silent browser drop with disconnect+resume (research §§2.3-2.4, 4.1, 8(b)-8(c); spec §10).
- Relay logs/metrics: connection counts, route-owner state, bytes/frames, queue high-water, close reason, health/drain only. No payload, inner discriminant, device label, API path, terminal ID, or ciphertext dump. No offline message store or terminal snapshot (research §§4.2, 8(c); spec §10).

- [ ] **Step 1: failing router tests** — daemon+two devices route random opaque binary frames byte-for-byte; unknown destination/connection closes safely; duplicate attach resolves deterministically; detach removes live routes; browser cannot impersonate the daemon attach credential (route-claim token is routing metadata, separate from `#k`).
- [ ] **Step 2: failing queue/backpressure tests** — capacity awaits/drains in order; frame/byte over-cap closes the slow peer; fast peers continue; no silent drop; no payload retained after detach; graceful drain stops new attaches and lets bounded writes finish.
- [ ] **Step 3: failing zero-knowledge tests** — instrument decoder imports/log sink/persistence adapter and prove inner bytes are never parsed, logged, or stored; plaintext sent inside a test ciphertext-shaped blob remains observable only to the receiving test peer.
- [ ] **Step 4: implement Bun server/router/metrics** — product-policy defaults unlimited; enforce only safety bounds. Reserve separately signed `RelayPolicyFrame` handling but emit none in v0.3 (spec §10; research §8(b)).
- [ ] **Step 5: green + `bun build --compile apps/relay/src/index.ts` smoke.**
- [ ] **Step 6: Commit** — `feat: add zero-knowledge relay byte router`

---

### Task 5: Relay owner-node leases + non-owner byte proxying

**Files:**
- Create: `apps/relay/src/{owner,proxy}.ts`
- Test: `apps/relay/test/owner-proxy.test.ts`
- Modify: `apps/relay/src/{server,router,index}.ts`, `apps/relay/package.json`

**Interfaces:**

```ts
type OwnerLease = { daemonDeviceId: string; nodeId: string; internalUrl: string; expiresAt: number };
interface OwnerDirectory {
  claim(daemonDeviceId: string, self: RelayNode): Promise<OwnerLease>;
  lookup(daemonDeviceId: string): Promise<OwnerLease | null>;
  refresh(lease: OwnerLease): Promise<void>;
  release(lease: OwnerLease): Promise<void>;
}
interface ByteProxy { proxyWebSocket(owner: OwnerLease, downstream: WebSocket): Promise<void> }
```

Default single-node/self-host uses `InMemoryOwnerDirectory`. Hosted horizontal mode supplies a Redis-backed lease adapter containing only route→owner/expiry data; no session/control/ciphertext snapshot. A device landing on a non-owner is proxied as raw WebSocket bytes over private authenticated TLS to the owner. Daemon reconnect may claim/transfer ownership; the old owner drains/closes. Use the researched 20-second refresh / 300-second crash TTL as the initial configurable lease values, immediate release on clean close, and no copied 2-second app heartbeat (`docs/research/sshx-relay-e2e.md` §§4.2-4.3, 8(b)-8(c); spec §10).

- [ ] **Step 1: failing owner tests** — claim/lookup/refresh/release; stale claimant cannot release a newer lease; daemon reconnect transfers ownership; clean close releases immediately; TTL expiry permits recovery.
- [ ] **Step 2: failing two-node proxy test** — daemon owns node A, browser lands on B, B proxies random opaque frames byte-for-byte both ways; B never invokes an inner decoder or retains frames; owner loss yields close/reconnect, not hidden buffering.
- [ ] **Step 3: implement in-memory + optional Redis directory** — resolve latest-stable Redis client/API at execution; keys store only route/owner lease data. Internal proxy authenticates nodes with an operator cluster credential over TLS; it never reuses device pairing keys.
- [ ] **Step 4: metrics/drain tests + full suite/typecheck/relay compile.**
- [ ] **Step 5: Commit** — `feat: add relay owner leases and opaque node proxy`

---

### Task 6: Daemon identity, pairing tickets, paired-device persistence, revoke/rotate

**Files:**
- Create: `apps/daemon/src/relay/{device-store,pairing}.ts`, `apps/daemon/src/store/devices.ts`
- Modify: `apps/daemon/src/{config,index}.ts`, `apps/daemon/src/store/db.ts`, `apps/daemon/src/http/api-handler.ts`
- Test: `apps/daemon/test/{device-store,pairing}.test.ts`, extend migration/HTTP tests

**Interfaces:**

```ts
type PairedDevice = {
  id: string; label: string; publicKey: Uint8Array;
  fingerprint: string; createdAt: number; lastSeenAt: number | null; revokedAt: number | null;
};
interface PairingService {
  createTicket(): { url: string; capability: Uint8Array; expiresAt: number };
  consumeAfterMutualReady(ticketId: string, device: PairedDevice): Promise<void>;
  rotateLink(): { url: string; expiresAt: number };
  listDevices(): PairedDevice[];
  revokeDevice(deviceId: string): Promise<void>;
  authorize(deviceId: string, publicKey: Uint8Array): PairedDevice;
}
```

Generate one daemon X25519 identity once; store secret material under the daemon data directory with `0600` file / `0700` directory permissions. Generate a distinct stable 32-byte relay route-claim secret; define `daemonDeviceId = base64url(SHA-256(routeClaimSecret))`; send the secret only in the daemon's TLS-protected WSS Authorization header and never place it in a browser link. Browser device IDs are random and public; browser labels stay encrypted. Pairing URLs are exactly `https://<relay>/d/<daemonDeviceId>#k=<base64url-32-byte-capability>`; the server-side route sees no `k` (`docs/research/sshx-relay-e2e.md` §§1.1, 1.6, 3.1, 8(a); spec §10).

The binding security interpretation is a one-time, 10-minute ticket: capability is transactionally consumed only after mutual encrypted `ready`, and concurrent reuse has one winner. Rotate invalidates every unconsumed prior ticket and creates a new one; it does **not** revoke already-paired device keys. Per-device revoke marks the key revoked, closes its live sessions, deletes its push subscriptions, and rejects every later handshake. A completed pair emits an encrypted `device.paired` confirmation to already-paired surfaces; it does not Web Push (research §§1.6, 3.2, 8(a), 8(d); spec §§10-11).

- [ ] **Step 1: failing migration/store tests** — identity stable across restart; permissions strict; paired key round-trips; duplicate key/device rejected; revoked key remains rejected; migrations are atomic/idempotent.
- [ ] **Step 2: failing ticket tests** — URL exact and fragment-only; 32-byte entropy shape; expiry; one-time concurrent consume; bad proof never consumes; rotate invalidates old tickets only; daemon restart preserves only still-valid tickets under the selected storage design.
- [ ] **Step 3: failing API/service tests** — `POST /api/pairing/ticket`, `POST /api/pairing/rotate`, `GET /api/devices`, `DELETE /api/devices/:id`; localhost token or established E2E RPC required; revoke closes target peers/deletes subscriptions; paired confirmation excludes capability/key material.
- [ ] **Step 4: implement + green + full suite/typecheck.**
- [ ] **Step 5: Commit** — `feat: add fragment pairing and revocable device identities`

---

### Task 7: Daemon relay client + encrypted application bridge + replay reconciliation

**Files:**
- Create: `apps/daemon/src/relay/{client,peer-session,replay}.ts`, `apps/daemon/src/http/api-handler.ts`
- Modify: `apps/daemon/src/{index,events}.ts`, `apps/daemon/src/http/{server,ws}.ts`, `apps/daemon/src/pty/{manager,ring}.ts`
- Test: `apps/daemon/test/{relay-client,relay-replay}.test.ts`, extend HTTP/PTY tests

**Interfaces:**
- `class RelayClient { start(): Promise<void>; state: "down"|"connecting"|"open"; onPeer(frame): void; closeDevice(id): void; stop(): Promise<void> }` opens outbound WSS with exponential backoff capped at 15s + ±20% jitter (reuse current `nextDelay` behavior, never sshx's fixed 500ms); no inbound port is added (`docs/research/sshx-relay-e2e.md` §§3.1, 4.3, 8(c); spec §§3, 9.2, 10).
- Extract the current REST route body into a transport-neutral `dispatchApi({method,path,body,authContext}) → {status,body}` used by local HTTP and encrypted `rpc.req`; extract the current WS PTY/event fan-out into a reusable application port. Localhost behavior and auth token remain unchanged.
- `class PeerSession` runs Task-3 handshake/secretstreams, validates/decrypts `SecureAppFrame`, authorizes the pinned device before dispatch, and encrypts every response/event/terminal/control message. Device labels, API paths, SIDs, event kinds, and errors never enter outer frames (spec §10; research §§2.2-2.4, 8(b)).
- `ReplayWindow` assigns absolute byte offsets to PTY output and monotonic event sequence numbers. On reconnect/new epoch, browser sends `term.subscribe(afterByteSeq)` + `sync`. The daemon sends the unseen suffix; full duplicates are ignored; a cursor older than the existing 200KB ring yields `term.reset(baseByteSeq,snapshot)`. The relay stores none of it. Each transport change starts fresh secretstreams and resumes from application cursors (`docs/research/sshx-relay-e2e.md` §§2.3, 5.2, 8(b), 8(e); spec §§9.2, 10).
- Mutating RPC and `term.input` require `PeerSession.established === true`; no retry queue. `commandId` dedupes accidental duplicates, but an unacknowledged command is never auto-replayed after reconnect.

- [ ] **Step 1: failing bridge parity tests** — the same GET/POST/PATCH/DELETE fixture through local `dispatchApi` and encrypted RPC returns equivalent status/body; malformed/unauthorized remote frames never reach handlers; local `/api` + `/ws` tests remain unchanged.
- [ ] **Step 2: failing replay tests** — exact suffix after reconnect; duplicate/overlap trimmed; forward gap requests resync; too-old cursor sends one reset snapshot; event cursor resumes or requests state refetch when history expired; no duplicate terminal bytes reach the browser.
- [ ] **Step 3: failing outage/command tests** — relay down does not stop daemon/PTY; input/action while down rejects immediately; ack-lost command is not auto-replayed; duplicated `commandId` is applied once; per-device revoke closes only that peer.
- [ ] **Step 4: implement outbound lifecycle + app bridge** — bounded daemon-owned journals; selected Task-1 crypto; Task-5 owner transfer; clean shutdown before DB close. Avoid 2-second application heartbeat; use WSS lifecycle/lease cadence.
- [ ] **Step 5: green + full suite/typecheck/compiled-daemon smoke.**
- [ ] **Step 6: Commit** — `feat: bridge daemon API and terminal streams over encrypted relay`

---

### Task 8: Signed UI manifest + externally pinned bootstrap verifier

**Files:**
- Create: `scripts/sign-ui-manifest.ts`, `apps/web/src/bootstrap/{bootstrap,verify-manifest}.ts`, bootstrap tests/fixture keys
- Modify: `apps/web/{index.html,vite.config.ts,package.json}`, `apps/relay/src/server.ts`, root build scripts
- Test: `apps/web/src/test/bootstrap.test.ts`, `apps/relay/test/assets.test.ts`

**Interfaces:**

```ts
function verifyManifest(signed: SignedUiManifest, pinnedEd25519PublicKey: Uint8Array, floor: number): UiManifestPayload;
async function fetchVerifyAssets(manifest: UiManifestPayload): Promise<Map<string, Uint8Array>>;
async function bootstrapRemote(opts: {
  manifestUrl: URL; pinnedKey: Uint8Array; releaseFloor: number;
  takeCredentialAfterVerification(): string;
}): Promise<void>;
```

Release build hashes every executable/style/service-worker asset, encodes the exact manifest payload, and signs it with an offline Ed25519 release key supplied only to the signing step. No private signing key enters git, relay image layers, daemon, or browser. Bootstrap pins the publisher public key, verifies signature, protocol version, asset hashes/sizes, entrypoint membership, and monotonic rollback counter before creating any Blob/import/style or handing `#k` to verified code. Failure is a fixed bootstrap error with no dynamic HTML. WebCrypto Ed25519 + SHA-256 is preferred so the bootstrap does not load an unverified crypto dependency; browser support is proved in Task 1/Task 15 (`docs/research/sshx-relay-e2e.md` §7; spec §10).

Hosted `/d/:daemonDeviceId` issues a fragment-blind redirect to the controller-approved independent publisher bootstrap origin, carrying only relay/route information; the browser preserves `#k`, and neither origin receives it in HTTP. Self-host may serve the same compiled bootstrap from the same image under the documented operator-trust boundary, but authenticated E2E frames remain mandatory. Unsigned remote builds are refused; an explicit localhost-only development mode may use a checked-in test public key (`docs/research/sshx-relay-e2e.md` §7; spec §10).

- [ ] **Step 1: failing signer/verifier tests** — known Ed25519 fixture verifies; byte/signature/hash/size/entrypoint/protocol/rollback tampering rejects; duplicate asset paths and traversal reject; release private key absence fails the release-sign command.
- [ ] **Step 2: credential-isolation tests** — spy callback proves the fragment is not read/cleared/passed to app code until every asset verifies; all failure branches leave it undisclosed to mutable assets; redirect requests contain route fields but never `k`.
- [ ] **Step 3: implement build/sign/serve pipeline** — verified single entry bundle + CSS/service worker assets; strict MIME/CSP; relay serves immutable hashed assets and signed manifest, not a mutable unverified app shell.
- [ ] **Step 4: rollback/update tests + Vite/relay build green.** Actual hosted-origin Chrome proof is deferred to Task 15.
- [ ] **Step 5: Commit** — `feat: verify signed remote UI from pinned bootstrap`

---

### Task 9: Browser transport abstraction + encrypted relay transport

**Files:**
- Create: `apps/web/src/transport/{types,local,relay,reconcile}.ts`
- Modify: `apps/web/src/{api,wsCore}.ts`, `apps/web/src/main.tsx`, transport consumers in `apps/web/src/components/`
- Test: `apps/web/src/test/{transport,reconnect}.test.ts`, retain direct-envelope tests

**Interfaces:**

```ts
interface CodegentTransport {
  readonly mode: "local" | "relay" | "lan";
  readonly state: "open" | "connecting" | "down";
  request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
  onState(cb: (state: WsState) => void): () => void;
  onReconnect(cb: () => void): () => void;
  onEvent(cb: (event: DomainEvent) => void): () => void;
  sub(sid: string, onData: (bytes: Uint8Array) => void): () => void;
  input(sid: string, bytes: Uint8Array): void;
  resize(sid: string, cols: number, rows: number): void;
  close(): void;
}
function selectTransport(location: Location, boot: VerifiedBootContext): CodegentTransport;
```

`LocalTransport` wraps the existing same-origin fetch + `/ws` implementation without changing wire behavior. `RelayTransport` uses the verified in-memory credential/device key, WSS outer frames, Task-3 authenticated handshake, one secretstream each direction, and Task-7 RPC/replay. Reopen always creates a new connection epoch and fresh secretstreams, invokes reconnect callbacks before subscription resume, and uses exponential backoff/jitter — never secretstream-state transplant or fixed 500ms retry (`apps/web/src/{api,wsCore}.ts`; research §§2.3, 4.3, 5.2, 8(e); spec §§3, 9.2, 10).

- [ ] **Step 1: failing transport-contract suite** — run the same request/event/sub/input/resize/close behavior table against fake Local and Relay transports; `selectTransport` chooses localhost direct for local origins and relay only from a verified remote boot context.
- [ ] **Step 2: failing reconnect/reconciliation tests** — new epoch/headers each open; reconnect callbacks precede re-subscribe; exact `afterByteSeq`; reset sanitizes terminal before snapshot; stale socket events ignored; bounded callbacks/queues cleared on close.
- [ ] **Step 3: failing dead-link tests** — mutating request/input/resize while down rejects/does not enqueue; safe subscription intent is retained as a cursor only; hostile/malformed ciphertext closes and clears keys without dispatch.
- [ ] **Step 4: implement and migrate consumers** — `api.get/post/patch/del` delegate to selected transport; existing component call sites stay stable where possible. Unit/integration only; live remote Chrome deferred to Task 15.
- [ ] **Step 5: Commit** — `feat: add encrypted browser relay transport alongside localhost`

---

### Task 10: Browser device pairing, confirmation, revoke, and rotate surfaces

**Files:**
- Create: `apps/web/src/pairing/{credential,device-store,controller}.ts`, `apps/web/src/components/PairingPanel.tsx`
- Modify: `apps/web/src/components/Shell.tsx`, `apps/web/src/main.tsx`, `apps/web/src/theme.css`
- Test: `apps/web/src/test/pairing.test.ts`, component tests; extend daemon pairing integration tests

**Interfaces:**
- `readPairingCredential(hash) → {capability: Uint8Array}|null` accepts one canonical base64url `#k`, rejects duplicates/unknown fragment keys, keeps capability in memory only, and clears the URL fragment immediately after the trusted bootstrap transfers it. It never writes the capability to localStorage, IndexedDB, logs, crash text, analytics, fetch, or WSS outer fields (spec §10; research §§1.1, 1.6).
- `BrowserDeviceStore.loadOrCreate() → DeviceKeyPair & {deviceId,label}` persists the browser's long-term secret in IndexedDB (raw bytes are unavoidable for libsodium; document the browser-origin/XSS boundary), never in sync storage. Daemon key pin + paired device ID persist only after mutual `ready` (spec §10; research §§1.6, 7, 8(a)).
- Minimal Part-2 `PairingPanel`: link + QR with expiry; rotate link; paired devices (label, short fingerprint, paired/last-seen time); revoke. Part 4 relocates/expands this into final Settings/first-run. New pairing raises an encrypted in-app confirmation on already-paired surfaces with device label/fingerprint/revoke action; no terminal content and no Web Push (spec §§8, 10-11; research §§3.2, 8(d)).

- [ ] **Step 1: failing credential/store tests** — valid canonical fragment parses once; malformed/duplicate fragments reject; fragment clearing; no persistence/log calls contain capability; generated key remains stable; failed pairing leaves no daemon pin/device authorization.
- [ ] **Step 2: failing pairing integration tests** — first device pairs; second device triggers confirmation on first; concurrent same-ticket second loses; wrong daemon pin fails; refresh resumes with device key; revoked device's active transport closes and future reconnect fails; rotate invalidates old URL while existing paired devices continue.
- [ ] **Step 3: failing UI tests** — QR encodes exact fragment URL; expiry shown; device list/revoke/rotate reachable by keyboard; destructive revoke targets exact device and confirms in-product; grammar/English/no-emoji constraints; capability never appears in rendered diagnostic text after bootstrap.
- [ ] **Step 4: implement with latest-stable QR dependency (or a small audited encoder) + green.** Live two-surface Chrome flow deferred to Task 15.
- [ ] **Step 5: Commit** — `feat: add confirmed device pairing and revocation surfaces`

---

### Task 11: Daemon Web Push — VAPID, subscriptions, exact payload, direct delivery

**Files:**
- Create: `packages/protocol/src/notifications.ts`, `apps/daemon/src/push/{service,payload,store}.ts`, `apps/daemon/src/store/push.ts`
- Modify: `packages/protocol/src/index.ts`, `apps/daemon/src/{config,index}.ts`, `apps/daemon/src/store/db.ts`, `apps/daemon/src/http/api-handler.ts`, `apps/daemon/src/orchestrator/{engine,machine}.ts`
- Test: `packages/protocol/test/notifications.test.ts`, `apps/daemon/test/{push,push-store}.test.ts`, extend engine/migration tests

**Interfaces:**

```ts
type PushKind = "waiting-for-input" | "error" | "review-ready";
type PushPayload = { project: string; taskTitle: string; kind: PushKind; elapsed: number };
interface PushService {
  publicKey(): string;
  subscribe(deviceId: string, subscription: PushSubscriptionJSON): void;
  unsubscribe(deviceId: string, endpoint: string): void;
  send(cardId: number, kind: PushKind, now: number): Promise<void>;
}
function pushKindForTransition(before: Card, after: Card): PushKind | null;
```

Resolve latest-stable `web-push` (or an equivalently maintained standards implementation) at execution. Generate VAPID keys once per daemon with its documented keygen, persist private key under `0600`, expose only public key, and use library-managed RFC Web Push encryption/VAPID — no hand-rolled encryption. Subscription endpoints/`p256dh`/`auth` arrive through local auth or E2E RPC, are tied to an authorized non-revoked device, and are deleted on revoke or push-service 404/410 (spec §11; research §7).

`PushPayloadSchema.strict()` permits exactly four fields; `elapsed` is non-negative integer seconds derived from the current attempt's start to `now`. Map question+permission→waiting; silent→none; working crash/StopFailure transitions that already emit the machine's push effect→error; complete→review-ready. Preserve the existing no-push behavior for `start_failed` and `interrupted` unless the controller changes the state-machine contract. No card body, prompt, terminal bytes, timeline, diff, error detail, branch, path, comments, device ID, endpoint, or relay status enters payload/log. Delivery calls `webpush.sendNotification(subscription, payload, ...)` directly from `PushService`; `RelayClient` is not imported (`docs/research/sshx-relay-e2e.md` §7; spec §§4.1, 11).

- [ ] **Step 1: failing VAPID/store tests** — one-time stable generation; strict permissions; public-only API; valid subscription round-trip; wrong/revoked device rejects; 404/410 deletes; transient failure retains with bounded retry policy.
- [ ] **Step 2: failing payload mapping/golden tests** — exactly the three enum values/four keys; question+permission collapse; silent/running/stopped/start-failed/interrupted/pairing emit none under the current machine; extra sensitive fields reject; elapsed uses injected clock.
- [ ] **Step 3: failing direct-path test** — inject HTTP sender + relay spy; push-service origin receives one encrypted library request while relay spy receives zero frames, including when relay client state is `down`.
- [ ] **Step 4: implement engine effect dispatch + APIs** — `GET /api/push/vapid-key`, `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions`; push failures never roll back card transitions. Adapt effect wiring to the Part-1 engine state actually merged.
- [ ] **Step 5: green + full suite/typecheck/compiled-daemon smoke.**
- [ ] **Step 6: Commit** — `feat: send content-minimal Web Push directly from daemon`

---

### Task 12: Browser Web Push subscription + service worker notification UX

**Files:**
- Create: `apps/web/src/push/{register,service-worker}.ts`
- Modify: `apps/web/src/components/Shell.tsx`, `apps/web/src/main.tsx`, `apps/web/vite.config.ts`, signed asset manifest inputs
- Test: `apps/web/src/test/push.test.ts`, service-worker fixture tests

**Interfaces:**
- `registerPush(transport, registration) → Promise<"subscribed"|"denied"|"unsupported">` fetches VAPID public key through the selected local/E2E transport, calls `PushManager.subscribe({userVisibleOnly:true, applicationServerKey})`, and registers the subscription with the daemon. Permission is requested only from a user gesture on the one-time strip chip shown when any card first enters Waiting — never on page load/modal (spec §11).
- Service worker parses strict `PushPayload`, renders only task title + project/kind/elapsed, and uses a deterministic per-card collapse mechanism without adding payload content. The daemon supplies an opaque Web Push `Topic` header for push-service replacement; the worker's notification `tag` is derived from permitted payload fields pending the controller's task-ID decision. Notification click opens/focuses the verified app, where current encrypted state resolves the task (`docs/research/sshx-relay-e2e.md` §7; spec §§7.7, 11).
- Service worker is itself a signed-manifest asset; it rejects malformed/extra-field payloads and never falls back to displaying raw strings.

- [ ] **Step 1: failing permission/subscription tests** — no load-time prompt; first Waiting exposes chip once; click drives default/denied/granted paths; VAPID key conversion exact; subscription travels through selected transport; revoke/unsubscribe cleanup.
- [ ] **Step 2: failing worker tests** — all three kinds render allowed fields only; same-card replacement tag stable while elapsed changes; malformed/extra-field payload ignored; silent/running fixture produces no daemon send; click focuses/opens verified app without embedding secrets.
- [ ] **Step 3: signed-asset/build tests** — service worker hash appears in `UiManifestPayload`; tampered worker is rejected by bootstrap/update flow; Vite production build registers correct immutable URL/scope.
- [ ] **Step 4: implement + unit/build green.** Real permission and push-service delivery are deferred to Task 15.
- [ ] **Step 5: Commit** — `feat: add contextual Web Push subscription and worker`

---

### Task 13: LAN-direct — opportunistic encrypted WebRTC DataChannel with WSS fallback

**Decision:** **Use ordered, reliable WebRTC DataChannel, not direct LAN WebSocket.** Browser WebRTC solves local TLS certificate trust, mixed-content, Private Network Access, and address-discovery problems that make zero-friction `wss://<private-ip>` brittle. Relay WSS already provides authenticated encrypted signaling and a guaranteed fallback. Keep codegent's X25519 + secretstream above WebRTC/DTLS so identity/framing/resume are transport-independent (`docs/research/sshx-relay-e2e.md` §§5.2, 8(e); spec §10).

**Files:**
- Create: `apps/daemon/src/relay/lan-direct.ts`, `apps/web/src/transport/lan.ts`
- Modify: `apps/daemon/src/relay/peer-session.ts`, `apps/web/src/transport/relay.ts`, `packages/protocol/src/relay.ts`, package manifests
- Test: `apps/daemon/test/lan-direct.test.ts`, `apps/web/src/test/lan-direct.test.ts`

**Interfaces:**

```ts
interface DirectCandidate {
  race(signal: EncryptedSignalChannel, deadlineMs?: number): Promise<RTCDataChannelLike | null>;
}
interface MigratingTransport {
  current: "relay" | "lan";
  promote(channel: RTCDataChannelLike, resume: SyncCursor): Promise<void>;
  fallback(): Promise<void>;
}
```

Browser uses native `RTCPeerConnection`; daemon evaluates latest-stable Bun-compatible DataChannel libraries at execution, preferring a pure-TypeScript implementation with proven Chrome interoperability/compiled-binary support (current candidate: `werift`) over a native addon. SDP/ICE messages ride `webrtc.signal` **inside the existing secretstream**, so the relay cannot read LAN addresses. Start the race only after relay transport is established; use a 5-second injected-clock deadline; no TURN dependency for the LAN optimization. Success performs a fresh authenticated Task-3 handshake, new epoch, new secretstreams, and cursor resume on the DataChannel before switching. Failure/closure keeps or restores WSS; never transplant secretstream state (`docs/research/sshx-relay-e2e.md` §5.2; spec §10).

- [ ] **Step 1: failing negotiation tests** — offer/answer/trickle ICE encrypted through signal abstraction; no SDP/candidate appears in an outer frame/log; deadline/failure returns null and leaves WSS untouched.
- [ ] **Step 2: Bun↔Chrome DataChannel interop spike inside the task** — resolve/package candidate, prove ordered reliable binary messages and compiled daemon on supported current platform; if the candidate fails, test the next maintained implementation and record the choice. If none works, escalate LAN-direct specifically; core WSS remains safe but §10 is not complete.
- [ ] **Step 3: failing migration tests** — fresh epoch/headers; resume exact output cursor with no duplicate/gap; in-flight mutating command is never replayed; direct close falls back to a new WSS epoch; stale direct frames ignored.
- [ ] **Step 4: implement + unit/integration/build green.** Actual LAN candidate selection visible in Chrome is deferred to Task 15.
- [ ] **Step 5: Commit** — `feat: add encrypted WebRTC LAN-direct with relay fallback`

---

### Task 14: Relay Docker image + same-binary self-host deployment

**Files:**
- Create: `apps/relay/Dockerfile`, `.dockerignore`, `deploy/relay/{Caddyfile.example,compose.yaml}`, `docs/self-host-relay.md`
- Modify: `apps/relay/src/{index,server}.ts`, root build scripts, relay README/package metadata
- Test: container smoke script/test under `apps/relay/test/`

**Interfaces / deployment contract:**
- One Bun-compiled relay binary serves WSS router, `/healthz`, signed manifest/assets, and bootstrap redirect. The exact same binary/image runs hosted and self-hosted; configuration only changes public origin, listen address, optional Redis owner directory, cluster/private proxy settings, bootstrap origin, and graceful-drain timings. No daemon code or user content volume enters the image (`docs/research/sshx-relay-e2e.md` §§6.1-6.2, 8(c); spec §§3, 10, 14).
- Multi-stage linux/amd64 + linux/arm64 build; non-root minimal final image; Caddy terminates TLS and proxies ordinary WSS with drain/stream-close behavior. `docker run codegent/relay` works single-node without Redis; optional compose profile adds Redis routing leases only. The relay has no content snapshot volume/database (research §§4.2, 6.2, 8(c); spec §10).
- `/healthz` distinguishes accepting/readiness from draining; SIGTERM stops new attaches, drains bounded sends, closes peers so jittered clients resume, then exits within a documented timeout.

- [ ] **Step 1: failing config/startup tests** — reject invalid public/internal URLs, missing hosted bootstrap configuration, unsafe listen/cluster combinations, and production unsigned assets; self-host single-node defaults require no Redis.
- [ ] **Step 2: build/run smoke** — build both target architectures in CI-capable environment; run non-root container; `/healthz`; daemon+browser opaque WSS round-trip; no writable content path; image contains no signing/private/device keys.
- [ ] **Step 3: Caddy/drain smoke** — TLS/WSS proxy works; SIGTERM/readiness flip/close/reconnect clean; Caddy reload guidance prevents synchronized socket churn (research §6.2).
- [ ] **Step 4: write self-host docs** — exact `docker run` and compose/Caddy examples, optional Redis/cluster, update procedure, threat boundary, no hosted-only binary. No “forever unlimited” promise (spec §10).
- [ ] **Step 5: Commit** — `feat: ship same-binary relay image and self-host recipe`

---

### Task 15: Part-2 gate — live pairing + relay round-trip + direct Web Push + LAN fallback

**Files:**
- Create: `docs/security/relay-threat-model.md`
- Modify: `README.md` (factual remote/security/self-host/push summary only), any exact docs found stale during the driver
- Verify: SONNET driver + Chrome DevTools MCP; report/screenshots under `.superpowers/sdd/`

**This is the deferred live payoff gate.** Use a throwaway daemon data dir/repo, a locally built relay container, the production signed-asset path, real Chrome surfaces, and an actual browser push subscription. No mocked crypto, pairing, WSS, push service, or DataChannel in the live path.

1. Start daemon + relay; prove daemon has only loopback inbound listeners and one outbound WSS. Localhost UI remains functional with relay disabled.
2. Open a fresh Chrome profile/context with the exact `.../d/<daemonID>#k=...` URL; inspect relay/bootstrap request logs and prove the fragment never arrived. Complete pairing and capture daemon-key/device fingerprints.
3. Pair a second surface; the first receives the encrypted pairing confirmation. Reuse the consumed link (fail), rotate and try the old link (fail), then pair with the new link (pass). Revoke exactly one device; its active session closes/reconnect rejects while the other device remains live.
4. Through the remote relay transport: list/create/update a card; subscribe to a real PTY; type and resize; verify terminal bytes/events round-trip and the relay logs only outer IDs/size/timing. Scan relay logs/storage for known task title, API path, SID, input bytes, SDP, and error text — zero hits.
5. Drop/restart relay during terminal output. Daemon/card/PTY continue locally; remote reconnect uses a new epoch/secretstreams and resumes exact bytes/events without duplicate/gap. Attempt input/action while down and prove it was rejected, not queued/replayed.
6. Tamper signed manifest, asset hash, protocol version, and rollback counter one at a time; bootstrap refuses before verified app/fragment handoff. Restore valid release and pair normally.
7. Subscribe from the one-time Waiting chip. With relay stopped, drive exactly: question/permission→one `waiting-for-input` kind, crash→`error`, completion→`review-ready`. Confirm direct push-service delivery, exactly four payload fields, per-card replacement behavior, and zero relay frames. Confirm silent/running/pairing ordinary events do not push.
8. On the same LAN, let encrypted signaling establish an ordered reliable DataChannel; verify transport indicator/diagnostics select LAN only after a fresh authenticated epoch+resume. Force ICE failure/close; verify WSS fallback and another fresh epoch with no duplicate bytes or action replay.
9. Verify console clean, queue/connection metrics sane, no secret/capability/private key in UI/logs, and cleanup all containers, servers, Chrome test state, temp data, and repos.
10. Evidence: `.superpowers/sdd/part2-evidence-{pairing,relay,push,lan,manifest}.png`; report `.superpowers/sdd/part2-gate-report.md` records commands, selected package versions, observed routes, negative cases, cleanup, and PASS/FAIL.

- [ ] **Docs/threat model:** state honest-but-curious relay boundary, visible metadata (device IDs/sizes/timing), signed-bootstrap trust channel, device-key browser/XSS boundary, self-host parity, direct push-service metadata, and no telemetry. Cite spec §10/§11 and `docs/research/sshx-relay-e2e.md` verdict; never claim protection from a malicious verified UI or compromised endpoint.
- [ ] **Gate:** PASS only when every live/negative step above is evidenced, all suites/builds/container smoke are green, and no high/critical security issue remains. Otherwise keep Part 2 unmerged and escalate.
- [ ] **Commit** — `docs: document zero-knowledge relay and self-host threat model`
- [ ] **Branch gate** — push the dedicated Part-2 branch and merge it into the controller-designated v0.3 line only after controller review.

---

## Controller Decisions Requested Before Finalization

1. **Pinned-bootstrap distribution:** approve the draft's independently deployed publisher bootstrap + fragment-preserving redirect, or select another trust anchor genuinely outside mutable relay delivery (installed PWA/extension/local bootstrap handoff). Serving the “pinned” bootstrap fresh from the same relay is explicitly disallowed by the binding research (`docs/research/sshx-relay-e2e.md` §7; spec §10).
2. **Strict push contract vs operational/per-card requirements:** decide whether relay-loss/reconnect-digest map into the three task kinds or remain in-app, and whether an opaque task/collapse ID may be added outside the four-field payload. As drafted, there are exactly three kinds/four payload fields, relay-loss/digest stay in-app, and title+project-derived notification tags cannot distinguish duplicate task titles (spec §§9.2, 11; research §7).

## Self-Review (performed at write time)

1. **Spec §10 coverage:** X25519 device keys + authenticated transcript + per-connection ephemeral KX ✓(T1/T3) · one secretstream/direction, no double AEAD ✓(T1/T3) · WSS opaque relay / honest-but-curious boundary ✓(T2/T4) · bounded queues + sequence reconciliation + reconnect subscriptions ✓(T4/T7/T9) · owner-node + non-owner byte proxy ✓(T5) · outbound daemon/no ports + localhost coexistence ✓(T7/T9) · fragment credential/TOFU/device pin ✓(T1/T6/T10) · per-device revoke ✓(T6/T10) · paired-surface confirmation ✓(T6/T10) · rotate link ✓(T6/T10) · signed UI manifest/pinned bootstrap ✓(T2/T8) · LAN-direct + fresh epoch/WSS fallback ✓(T13) · same binary Docker/self-host ✓(T14) · threat model/live proof ✓(T15).
2. **Spec §11 coverage:** VAPID generation/persistence ✓(T11) · daemon→push service direct, never relay ✓(T11/T15) · strict no-content four-field payload ✓(T11/T12) · exactly three kinds and silent never pushes ✓(T11/T12) · contextual one-time permission ask ✓(T12) · per-card replacement intent ✓(T11/T12/T15). The relay-loss/digest and no-ID/per-card conflicts are surfaced as controller decision 2, not hidden as a fourth type/field.
3. **Placeholder scan:** “adapt to spike findings” is used only where Task 1 legitimately determines the runtime import/allocation/API contract, matching Part 1's VT-grid gate pattern. Package versions are intentionally resolved at execution under spec principle 7. The two product/trust contradictions are explicit controller decisions. No bare TODO/TBD or unowned “figure out crypto” step remains.
4. **Type consistency:** `RelayOuterFrame.payload` → Task-3 handshake or secretstream ciphertext; decrypted `SecureAppFrame.body` → Task-7 daemon app bridge / Task-9 browser transport. Fixed browser-client/daemon-server KX roles give browser.rx=daemon.tx and browser.tx=daemon.rx. `term.subscribe(afterByteSeq)` consumes daemon `ReplayWindow`; `term.chunk/term.reset` update browser cursors. `PushPayload` is produced by T11 and strictly consumed by T12. `UiManifestPayload` is defined in T2, signed/verified in T8, and covers T12's service worker.
5. **Crypto-fork adherence:** KEEP libsodium X25519 + `crypto_kx` + authenticated transcript + secretstream ✓ · peer static keys pinned/authorized before resume ✓ · fragment capability authenticates initial transcript and is never sent to relay ✓ · fresh ephemeral keys/session epoch ✓ · no sshx Argon2/AES-CTR/verifier ✓ · no second AEAD around secretstream ✓ · application sequence handles cross-connection replay/dedup ✓ · WebRTC transport change starts new secretstreams ✓ (`docs/research/sshx-relay-e2e.md` §§1.6, 2.3, 5.2, 8(a), 8(e); spec §10).
6. **Zero-knowledge/push boundary:** relay parses routing-only outer frames and stores owner leases only; inner control, signaling, content, and push events remain unavailable. Push deliberately bypasses relay and exposes only standard push-service metadata plus the encrypted minimal payload (spec §§10-11; research §§7-8).

## Execution Note

Task 1 is a **HARD GATE**. PASS requires the selected official libsodium stack to round-trip the same authenticated-handshake/secretstream vector daemon→browser and browser→daemon in Bun, a compiled daemon, and real Chrome, with transcript substitution/replay/tamper tests failing closed. On FAIL, stop and escalate; do not proceed with raw X25519, Node-crypto reimplementation, sshx crypto, nested AEAD, or any custom fallback.
