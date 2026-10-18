import { z } from "zod";

const RequestId = z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/, "Invalid request ID");

export const PromptDataSchema = z.object({
  text: z
    .string()
    .max(16000)
    .refine((text) => text.trim().length > 0, "Enter a message"),
  selection: z.string().max(24000).optional(),
  title: z.string().max(1000).optional(),
});

export const PromptSchema = PromptDataSchema.extend({
  type: z.literal("prompt"),
  requestId: RequestId,
});

export const CommandSchema = z.discriminatedUnion("type", [
  PromptSchema,
  z.object({ type: z.literal("stop"), requestId: RequestId }),
]);

export const MessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string(),
  error: z.boolean().optional(),
});

export const SnapshotSchema = z.object({
  messages: z.array(MessageSchema),
  partial: z.string(),
  busy: z.boolean(),
  queued: z.number().int().nonnegative(),
  tools: z.array(z.string()),
});

export const EventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), state: SnapshotSchema }),
  z.object({ type: z.literal("ack"), requestId: RequestId }),
  z.object({ type: z.literal("error"), message: z.string(), requestId: RequestId.optional() }),
]);

export const ResolveRequestSchema = z.object({ url: z.string().max(8192) });

export const SessionResponseSchema = z.object({
  id: z.string(),
  canonicalUrl: z.string(),
  ticket: z.string(),
});

export const OAuthStartSchema = z.object({ connected: z.boolean(), url: z.string().optional() });
export const ConnectionSchema = z.object({ connected: z.boolean() });
export const StatusSchema = ConnectionSchema.extend({ modelConfigured: z.boolean() });
export const ErrorSchema = z.object({ error: z.string() });

export const SelectionDraftSchema = z.object({
  url: z.string(),
  title: z.string().max(1000),
  selection: z.string().max(24000),
});

export type Prompt = z.infer<typeof PromptSchema>;

export type Command = z.infer<typeof CommandSchema>;

export type Message = z.infer<typeof MessageSchema>;

export type Snapshot = z.infer<typeof SnapshotSchema>;

export type Event = z.infer<typeof EventSchema>;

export type HttpResult = z.infer<
  typeof SessionResponseSchema | typeof OAuthStartSchema | typeof StatusSchema | typeof ErrorSchema
>;

export type JsonValue = z.infer<ReturnType<typeof z.json>>;

export function parseCommand(frame: string): Command {
  if (frame.length > 60000) throw new Error("Message too large");

  return CommandSchema.parse(JSON.parse(frame));
}
