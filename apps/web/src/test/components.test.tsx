import React from "react";
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card, SessionMeta } from "@codegent/protocol";
import { CardView, destructiveActionFor } from "../components/Card";
import { Details, sendBackComments } from "../components/Details";
import { SessionRail } from "../components/SessionRail";

const base: Card = {
  id: 1,
  projectId: "p",
  title: "Task",
  body: "Body",
  phase: "working",
  agent: "claude",
  worktreeId: null,
  position: 1,
  createdAt: 1_000,
  updatedAt: 1_000,
  workingSub: "starting",
  errorKind: null,
  reviewSub: null,
  inputKind: null,
  inputSince: null,
  round: 1,
  auto: true,
  attemptId: 1,
};

const cardMarkup = (card: Card, now = 43_000) => renderToStaticMarkup(
  <CardView
    card={card}
    column="running"
    now={now}
    onChanged={() => {}}
    onError={() => {}}
    onDetails={() => {}}
    onDiscarded={() => {}}
  />,
);

describe("CardView state grammar", () => {
  test("working.starting renders STARTING without RUNNING or elapsed time", () => {
    const html = cardMarkup(base);
    expect(html).toContain("Starting");
    expect(html).not.toContain("Running");
    expect(html).not.toContain("42s");
  });

  test("working.running renders RUNNING with a tabular elapsed metric", () => {
    const html = cardMarkup({ ...base, workingSub: "running" });
    expect(html).toContain("Running · 42s");
    expect(html).toContain("font-weight:500");
    expect(html).toContain("font-variant-numeric:tabular-nums");
  });

  test("destructive menu actions follow legal card state", () => {
    expect(destructiveActionFor({ phase: "queued" })).toBe("delete");
    expect(destructiveActionFor({ phase: "done" })).toBe("delete");
    expect(destructiveActionFor({ phase: "working" })).toBe("cancel");
    expect(destructiveActionFor({ phase: "review" })).toBe("cancel");
    expect(destructiveActionFor({ phase: "cancelled" })).toBeNull();
  });
});

test("SessionRail renders distinct metadata-only agent rows above shells", () => {
  const sessions: SessionMeta[] = [
    { id: "shell", projectId: "p", kind: "shell", title: "main", cwd: "/tmp", worktreeId: null, live: true, createdAt: 1, adapterSessionId: null, attemptId: null },
    { id: "claude", projectId: "p", kind: "agent", title: "Claude card", cwd: "/tmp/c1", worktreeId: "w1", live: true, createdAt: 2, adapterSessionId: null, attemptId: 1 },
    { id: "codex", projectId: "p", kind: "agent", title: "Codex card", cwd: "/tmp/c2", worktreeId: "w2", live: true, createdAt: 3, adapterSessionId: null, attemptId: 2 },
  ];
  const html = renderToStaticMarkup(
    <SessionRail
      sessions={sessions}
      cards={[base, { ...base, id: 2, title: "Codex card", agent: "codex", attemptId: 2 }]}
      worktrees={[]}
      openIds={[]}
      focusedId={null}
      onPick={() => {}}
      onNew={() => {}}
    />,
  );
  expect(html).toContain('data-agent-glyph="claude"');
  expect(html).toContain('data-agent-glyph="codex"');
  expect(html.indexOf("Claude card")).toBeLessThan(html.indexOf("main"));
  expect(html.indexOf("Codex card")).toBeLessThan(html.indexOf("main"));
});

describe("Details", () => {
  test("normalizes optional Send back comments", () => {
    expect(sendBackComments("   ")).toEqual([]);
    expect(sendBackComments("  fix this  ")).toEqual(["fix this"]);
  });

  test("blank Send back stays enabled and title/body fields expose id and name", () => {
    const client = new QueryClient();
    client.setQueryData(["sessions", "p"], [{
      id: "agent-1", projectId: "p", kind: "agent", title: "Task", cwd: "/tmp",
      worktreeId: null, live: true, createdAt: 1_000, adapterSessionId: null, attemptId: 1,
    }]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Details
          card={{ ...base, phase: "review", workingSub: null, reviewSub: "ready" }}
          projectId="p"
          sendBack
          onSession={() => {}}
          onClose={() => {}}
          onChanged={() => {}}
          onError={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain('id="card-title"');
    expect(html).toContain('name="title"');
    expect(html).toContain('id="card-body"');
    expect(html).toContain('name="body"');
    const button = html.match(/<button[^>]*>Send comments<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain("disabled");
    expect(html).toContain('data-session-link="agent-1"');
  });
});
