import { test, expect } from "bun:test";
import { encodeEnvelope, decodeEnvelope } from "@codegent/protocol";
import { b64ToBytes, bytesToB64 } from "../api";

test("base64 helpers roundtrip", () => {
  const bytes = new TextEncoder().encode("türkçe çıktı ✓");
  expect(new TextDecoder().decode(b64ToBytes(bytesToB64(bytes)))).toBe("türkçe çıktı ✓");
});

test("term frame decodes to bytes", () => {
  const env = decodeEnvelope(encodeEnvelope({ ch: "term", sid: "s", data: bytesToB64(new Uint8Array([1, 2, 3])) }));
  if (env.ch !== "term") throw new Error("wrong ch");
  expect([...b64ToBytes(env.data)]).toEqual([1, 2, 3]);
});

// The daemon's first `term` frame after `sub` is a full ring snapshot — up to
// 200KB in one payload. A spread-based encoder (`String.fromCharCode(...b)`)
// blows the call stack on payloads this size (engine- and stack-depth-
// dependent; reproducibly at 1MB even flat in JSC). 1MB = 5× ring size.
test("base64 helpers survive a ring-snapshot-sized payload", () => {
  const bytes = new Uint8Array(1_048_576);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256; // all byte values, non-uniform
  const b64 = bytesToB64(bytes);
  expect(b64).toBe(Buffer.from(bytes).toString("base64")); // exact oracle, catches chunk-boundary bugs
  expect(b64ToBytes(b64)).toEqual(bytes);
});
