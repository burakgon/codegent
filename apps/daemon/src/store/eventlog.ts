import type { Database } from "bun:sqlite";
import type { Card, DomainEvent } from "@codegent/protocol";

// §8 event log: "what happened while I slept". Rows are STATE FACTS —
// card-state entries + notices, title snapshots only, never terminal content.
// 30-day retention; card-scoped filtering.

export type EventLogRow = {
  id: number; ts: number; projectId: string; cardId: number | null; kind: string; title: string;
};

export function appendEventLog(db: Database, e: Omit<EventLogRow, "id">): void {
  db.query(
    `INSERT INTO event_log (ts, project_id, card_id, kind, title) VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).run(e.ts, e.projectId, e.cardId, e.kind, e.title);
}

export function listEventLog(
  db: Database, projectId: string, opts: { cardId?: number; limit?: number } = {},
): EventLogRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const rows = opts.cardId !== undefined
    ? db.query(`SELECT * FROM event_log WHERE project_id = ?1 AND card_id = ?2 ORDER BY id DESC LIMIT ?3`)
      .all(projectId, opts.cardId, limit)
    : db.query(`SELECT * FROM event_log WHERE project_id = ?1 ORDER BY id DESC LIMIT ?2`)
      .all(projectId, limit);
  return (rows as any[]).map(r => ({
    id: r.id, ts: r.ts, projectId: r.project_id, cardId: r.card_id, kind: r.kind, title: r.title,
  }));
}

export function sweepEventLog(db: Database, now = Date.now(), retentionMs = 30 * 24 * 3600_000): number {
  const res = db.query(`DELETE FROM event_log WHERE ts < ?1`).run(now - retentionMs);
  return res.changes;
}

/** The card's loggable state label — phase plus the discriminating sub. */
export function cardStateLabel(card: Card): string {
  if (card.phase === "working") {
    if (card.workingSub === "error") return `error.${card.errorKind ?? "unknown"}`;
    if (card.inputKind !== null) return `waiting.${card.inputKind}`;
    return `working.${card.workingSub ?? "running"}`;
  }
  if (card.phase === "review") return `review.${card.reviewSub ?? "ready"}`;
  return card.phase;
}

/** Bus subscriber: turns the DomainEvent stream into log rows by diffing each
 * card's last seen label (no-op updates never log). Notices log directly. */
export function eventLogTracker(db: Database, clock: () => number = Date.now): (e: DomainEvent) => void {
  const last = new Map<number, string>();
  return (e: DomainEvent): void => {
    if (e.t === "card") {
      const label = cardStateLabel(e.card);
      if (last.get(e.card.id) === label) return;
      last.set(e.card.id, label);
      appendEventLog(db, { ts: clock(), projectId: e.card.projectId, cardId: e.card.id, kind: label, title: e.card.title });
      return;
    }
    if (e.t === "cardDeleted") {
      last.delete(e.id);
      return;
    }
    if (e.t === "notice") {
      // notices carry no project — resolve via the card row (cheap, rare).
      const row = db.query(`SELECT project_id, title FROM cards WHERE id = ?1`).get(e.cardId) as
        | { project_id: string; title: string } | null;
      if (row) appendEventLog(db, { ts: clock(), projectId: row.project_id, cardId: e.cardId, kind: `notice.${e.kind}`, title: row.title });
    }
  };
}
