import { startDaemon } from "./daemon";

// Dev entry (`bun --watch src/index.ts`). The CLI (`rvmp start`) embeds
// startDaemon() directly; both paths are the same boot.
void startDaemon();
