import type { DomainEvent, MarkState } from "@codegent/protocol";
import type { DetectStateSnapshot } from "../agents/types";

/**
 * Spec §9.2 requires a persistent mismatch threshold but does not assign N.
 * One 30-second supervision pulse is the smallest documented default that
 * shares the engine's existing cadence while filtering transient classifier
 * flips. Tests inject a shorter threshold; production keeps this value.
 */
export const DEFAULT_MISMATCH_THRESHOLD_MS = 30_000;

export interface ManualOverride {
  state: MarkState;
  since: number;
}

export interface WatchdogObservation {
  cardId: number;
  manual: ManualOverride | null;
  detected: DetectStateSnapshot | null;
}

type MismatchNotice = Extract<DomainEvent, { t: "notice" }> & { kind: "mismatch" };

interface WatchdogOptions {
  clock: () => number;
  emit: (event: MismatchNotice) => void;
  thresholdMs?: number;
}

interface Latch {
  signature: string;
  since: number;
  emitted: boolean;
}

/**
 * Cross-checks sticky human state against live content-free detection. It is
 * observational only: a mismatch emits one enum-only notice and never changes
 * either the card flag or the classifier.
 */
export class Watchdog {
  readonly thresholdMs: number;
  private readonly latches = new Map<number, Latch>();

  constructor(private readonly options: WatchdogOptions) {
    this.thresholdMs = options.thresholdMs ?? DEFAULT_MISMATCH_THRESHOLD_MS;
  }

  tick(observations: readonly WatchdogObservation[]): void {
    const observed = new Set<number>();
    const now = this.options.clock();

    for (const observation of observations) {
      observed.add(observation.cardId);
      const { manual, detected } = observation;
      if (manual === null || detected === null || !disagrees(manual.state, detected.state)) {
        this.latches.delete(observation.cardId);
        continue;
      }

      const signature = `${manual.state}:${manual.since}:${detected.state}:${detected.since}`;
      let latch = this.latches.get(observation.cardId);
      if (latch?.signature !== signature) {
        latch = {
          signature,
          // Neither side can disagree before its current state began.
          since: Math.max(manual.since, detected.since),
          emitted: false,
        };
        this.latches.set(observation.cardId, latch);
      }

      if (!latch.emitted && now - latch.since > this.thresholdMs) {
        latch.emitted = true;
        this.options.emit({ t: "notice", cardId: observation.cardId, kind: "mismatch" });
      }
    }

    // Omitted cards are no longer active; a later active lifetime starts with
    // a fresh latch even if ids and enums happen to match.
    for (const cardId of this.latches.keys()) {
      if (!observed.has(cardId)) this.latches.delete(cardId);
    }
  }

  clear(cardId: number): void {
    this.latches.delete(cardId);
  }
}

function disagrees(manual: MarkState, detected: DetectStateSnapshot["state"]): boolean {
  return (manual === "running" && detected === "blocked")
    || (manual === "needs-input" && detected === "working");
}
