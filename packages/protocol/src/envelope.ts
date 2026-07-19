import { z } from "zod";
import { CardSchema, ProjectSchema, SessionMetaSchema } from "./entities";

export const DomainEventSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("card"), card: CardSchema }),
  z.object({ t: z.literal("cardDeleted"), id: z.number() }),
  z.object({ t: z.literal("session"), session: SessionMetaSchema }),
  z.object({ t: z.literal("project"), project: ProjectSchema }),
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;

export const EnvelopeSchema = z.discriminatedUnion("ch", [
  z.object({ ch: z.literal("term"), sid: z.string(), data: z.string() }),
  z.object({ ch: z.literal("event"), ev: DomainEventSchema }),
  z.object({ ch: z.literal("sub"), sid: z.string() }),
  z.object({ ch: z.literal("unsub"), sid: z.string() }),
  z.object({ ch: z.literal("input"), sid: z.string(), data: z.string() }),
  z.object({ ch: z.literal("resize"), sid: z.string(), cols: z.number(), rows: z.number() }),
]);
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const encodeEnvelope = (e: Envelope): string => JSON.stringify(EnvelopeSchema.parse(e));
export const decodeEnvelope = (s: string): Envelope => EnvelopeSchema.parse(JSON.parse(s));
