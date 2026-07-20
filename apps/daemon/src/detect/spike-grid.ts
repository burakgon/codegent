import {
  Ghostty,
  type GhosttyCell,
  type GhosttyTerminal,
} from "../../../../vendor/ghostty-web/lib/ghostty";

const CLEAN_SCREEN = "\x1b[H\x1b[2J\x1b[3J";
const MAX_OSC_BYTES = 4_096;
const MAX_OSC_VALUE_CHARS = 256;

export interface ScreenGridSnapshot {
  rows: string[];
  oscTitle: string | null;
  oscProgress: string | null;
}

export interface GhosttyScreenGridOptions {
  cols?: number;
  rows?: number;
  bottomRows?: number;
  ghostty?: Ghostty;
}

type OscState = "ground" | "escape" | "osc" | "oscEscape";

class OscTracker {
  private readonly decoder = new TextDecoder();
  private readonly payload: number[] = [];
  private state: OscState = "ground";
  private overflowed = false;
  title: string | null = null;
  progress: string | null = null;

  write(bytes: Uint8Array): void {
    for (const byte of bytes) {
      switch (this.state) {
        case "ground":
          if (byte === 0x1b) this.state = "escape";
          break;
        case "escape":
          if (byte === 0x5d) {
            this.startOsc();
          } else {
            this.state = byte === 0x1b ? "escape" : "ground";
          }
          break;
        case "osc":
          if (byte === 0x07) {
            this.commitOsc();
          } else if (byte === 0x1b) {
            this.state = "oscEscape";
          } else if (byte === 0x18 || byte === 0x1a) {
            this.reset();
          } else {
            this.push(byte);
          }
          break;
        case "oscEscape":
          if (byte === 0x5c) {
            this.commitOsc();
          } else {
            this.push(0x1b);
            this.push(byte);
            this.state = "osc";
          }
          break;
      }
    }
  }

  private startOsc(): void {
    this.payload.length = 0;
    this.overflowed = false;
    this.state = "osc";
  }

  private push(byte: number): void {
    if (this.payload.length < MAX_OSC_BYTES) {
      this.payload.push(byte);
    } else {
      this.overflowed = true;
    }
  }

  private commitOsc(): void {
    if (!this.overflowed) {
      const separator = this.payload.indexOf(0x3b);
      if (separator > 0) {
        const command = String.fromCharCode(...this.payload.slice(0, separator));
        const value = this.decoder
          .decode(Uint8Array.from(this.payload.slice(separator + 1)))
          .replace(/[\x00-\x1f\x7f]/g, "")
          .slice(0, MAX_OSC_VALUE_CHARS);

        if (command === "0" || command === "2") this.title = value;
        if (command === "9") this.progress = value;
      }
    }
    this.reset();
  }

  private reset(): void {
    this.payload.length = 0;
    this.overflowed = false;
    this.state = "ground";
  }
}

/**
 * Spike contract: keep one instance per PTY session and feed every output chunk
 * to screenGrid(). The returned rows are the rendered bottom viewport rows.
 */
export class GhosttyScreenGrid {
  private readonly osc = new OscTracker();
  private disposed = false;

  private constructor(
    private readonly terminal: GhosttyTerminal,
    private readonly bottomRows: number,
  ) {}

  static async create(options: GhosttyScreenGridOptions = {}): Promise<GhosttyScreenGrid> {
    const cols = positiveInteger(options.cols ?? 80, "cols");
    const rows = positiveInteger(options.rows ?? 24, "rows");
    const bottomRows = positiveInteger(options.bottomRows ?? 3, "bottomRows");
    const ghostty = options.ghostty ?? (await Ghostty.load());
    const terminal = ghostty.createTerminal(cols, rows);

    // ghostty-web 0.4.0 can recycle stale cell memory after free(); sanitize
    // each new headless terminal before accepting bytes from its PTY.
    terminal.write(CLEAN_SCREEN);
    return new GhosttyScreenGrid(terminal, bottomRows);
  }

  screenGrid(bytes: Uint8Array): ScreenGridSnapshot {
    this.assertLive();
    if (bytes.byteLength > 0) {
      this.osc.write(bytes);
      this.terminal.write(bytes);
    }
    return this.snapshot();
  }

  snapshot(): ScreenGridSnapshot {
    this.assertLive();
    this.terminal.update();
    const cells = this.terminal.getViewport();
    const firstRow = Math.max(0, this.terminal.rows - this.bottomRows);
    const rows: string[] = [];

    for (let row = firstRow; row < this.terminal.rows; row += 1) {
      rows.push(this.readRow(cells, row));
    }

    return {
      rows,
      oscTitle: this.osc.title,
      oscProgress: this.osc.progress,
    };
  }

  cursor(): { x: number; y: number } {
    this.assertLive();
    const cursor = this.terminal.getCursor();
    return { x: cursor.x, y: cursor.y };
  }

  resize(cols: number, rows: number): void {
    this.assertLive();
    this.terminal.resize(positiveInteger(cols, "cols"), positiveInteger(rows, "rows"));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.free();
  }

  private readRow(cells: GhosttyCell[], row: number): string {
    let text = "";
    const offset = row * this.terminal.cols;

    for (let col = 0; col < this.terminal.cols; col += 1) {
      const cell = cells[offset + col];
      if (!cell || cell.width === 0) continue;

      if (cell.grapheme_len > 0) {
        text += this.terminal.getGraphemeString(row, col);
      } else if (cell.codepoint === 0) {
        text += " ";
      } else if (cell.codepoint <= 0x10ffff) {
        text += String.fromCodePoint(cell.codepoint);
      } else {
        text += "�";
      }
    }

    return text.trimEnd();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("GhosttyScreenGrid has been disposed");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

async function runProof(): Promise<void> {
  const encoder = new TextEncoder();
  const grid = await GhosttyScreenGrid.create({ cols: 24, rows: 6, bottomRows: 3 });

  try {
    grid.screenGrid(encoder.encode("\x1b]2;OpenAI Co"));
    grid.screenGrid(encoder.encode("dex\x07\x1b]9;4;3;\x1b"));
    const result = grid.screenGrid(
      encoder.encode(
        "\\" +
          "\x1b[2J\x1b[Htop\r\nalpha\r\nbeta\r\ngamma\r\ndelta\r\nomega" +
          "\x1b[5;1H\x1b[2C\x1b[32mREADY\x1b[0m\x1b[6;1H\x1b[2K> ",
      ),
    );
    const cursor = grid.cursor();
    const expected: ScreenGridSnapshot = {
      rows: ["gamma", "deREADY", ">"],
      oscTitle: "OpenAI Codex",
      oscProgress: "4;3;",
    };

    if (JSON.stringify(result) !== JSON.stringify(expected)) {
      throw new Error(`unexpected proof result: ${JSON.stringify(result)}`);
    }
    console.log(JSON.stringify({ ...result, cursor }));
  } finally {
    grid.dispose();
  }
}

async function runBenchmark(): Promise<void> {
  const encoder = new TextEncoder();
  const unit = "\x1b[32mworking\x1b[0m payload 0123456789\r\n";
  const chunk = encoder.encode(unit.repeat(96));
  const grid = await GhosttyScreenGrid.create({ cols: 120, rows: 40, bottomRows: 24 });
  const iterations = Math.ceil((16 * 1024 * 1024) / chunk.byteLength);
  const rounds: number[] = [];

  try {
    for (let index = 0; index < 64; index += 1) grid.screenGrid(chunk);
    for (let round = 0; round < 5; round += 1) {
      const start = performance.now();
      for (let index = 0; index < iterations; index += 1) grid.screenGrid(chunk);
      const elapsedMs = performance.now() - start;
      rounds.push((iterations * chunk.byteLength) / (elapsedMs / 1_000));
    }
  } finally {
    grid.dispose();
  }

  const sorted = [...rounds].sort((left, right) => left - right);
  const medianBytesPerSecond = Math.round(sorted[Math.floor(sorted.length / 2)]);
  console.log(
    JSON.stringify({
      geometry: "120x40",
      bottomRows: 24,
      chunkBytes: chunk.byteLength,
      bytesPerRound: iterations * chunk.byteLength,
      rounds: rounds.map(Math.round),
      medianBytesPerSecond,
    }),
  );
}

if (import.meta.main) {
  await runProof();
  if (Bun.argv.includes("--bench")) await runBenchmark();
}
