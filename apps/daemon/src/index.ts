import { join } from "node:path";
import { loadConfig } from "./config";
import { openDb } from "./store/db";
import { PtyManager, sweepDeadRings } from "./pty/manager";
import { startServer } from "./http/server";
import { startHookReceiver, writeHookScript } from "./agents/receiver";

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, "db.sqlite"));

// Boot sweep: a crashed daemon leaves session rows marked live with no
// process behind them. PtyManager only flips rows at runtime, so heal
// ghosts here before serving.
db.query(`UPDATE sessions SET live = 0`).run();
// Ring GC rides the same sweep: dead sessions' scrollback dies with them,
// except the latest agent session per card's current attempt — that ring
// replays as the frozen "previous session" pane (spec §4.3).
sweepDeadRings(db, cfg.dataDir);

const ptys = new PtyManager(db, cfg.dataDir);
// Signal plane: loopback hook receiver + agent API on a random port with its
// own token (endpoint file + hook script under <dataDir>/agents). Adapters
// (T7) subscribe via receiver.onHook and spawn sidecars against it.
const receiver = startHookReceiver({ dataDir: cfg.dataDir, db });
writeHookScript(cfg.dataDir);
const srv = startServer(cfg, db, ptys);
console.log(`codegent daemon → ${srv.url}?t=${cfg.token}`);

// Shutdown ordering: stop accepting traffic, SIGHUP every live PTY, wait
// for all of them to exit, then close the db. Each session's exit handler
// (final ring flush + `live=0` write) was registered on `exited` at open()
// — before our allSettled reaction — so per-promise FIFO guarantees those
// db writes have run by the time allSettled resolves. Only then is it safe
// to close the handle.
let shuttingDown = false;
async function shutdown(): Promise<void> {
  // Second signal while draining: a PTY child ignoring SIGHUP must not make
  // the daemon unkillable — force quit.
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  srv.stop();
  receiver.stop(); // same phase: stop accepting traffic (hook scripts fail open)
  const live = ptys.liveSessions();
  for (const s of live) s.kill();
  await Promise.allSettled(live.map(s => s.exited));
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
