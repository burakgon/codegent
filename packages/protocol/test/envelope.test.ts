import { test, expect } from "bun:test";
import { encodeEnvelope, decodeEnvelope } from "../src/envelope";

test("envelope roundtrip: term data", () => {
  const e = { ch: "term", sid: "s1", data: Buffer.from("hello").toString("base64") } as const;
  expect(decodeEnvelope(encodeEnvelope(e))).toEqual(e);
});

test("decode rejects unknown channel", () => {
  expect(() => decodeEnvelope(JSON.stringify({ ch: "nope" }))).toThrow();
});
