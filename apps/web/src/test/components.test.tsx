import React from "react";
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@codegent/protocol";
import { CardView, destructiveActionFor } from "../components/Card";
import { Details, sendBackComments } from "../components/Details";

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

describe("Details", () => {
  test("normalizes optional Send back comments", () => {
    expect(sendBackComments("   ")).toEqual([]);
    expect(sendBackComments("  fix this  ")).toEqual(["fix this"]);
  });

  test("blank Send back stays enabled and title/body fields expose id and name", () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Details
          card={{ ...base, phase: "review", workingSub: null, reviewSub: "ready" }}
          projectId="p"
          sendBack
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
  });
});
