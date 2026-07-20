import type { Card } from "@codegent/protocol";

export type BoardColumn = "queue" | "running" | "waiting" | "review" | "done";

/**
 * Board columns are a pure view of orchestrator truth. Waiting is deliberately
 * derived from the input flag; the UI never persists it as a phase.
 */
export function columnOf(card: Card): BoardColumn | null {
  if (card.phase === "queued") return "queue";
  if (card.phase === "working") return card.inputKind === null ? "running" : "waiting";
  if (card.phase === "review") return "review";
  if (card.phase === "done") return "done";
  return null;
}

export function interruptedMessage(count: number): string {
  return count === 1
    ? "1 card interrupted — resume from its card"
    : `${count} cards interrupted — resume from their cards`;
}
