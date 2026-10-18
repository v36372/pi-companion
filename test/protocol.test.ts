import { describe, expect, it } from "vitest";
import {
  EventSchema,
  SessionResponseSchema,
  SelectionDraftSchema,
  parseCommand,
} from "../src/shared/protocol.ts";

describe("command validation", () => {
  const prompt = {
    type: "prompt",
    requestId: "request-123",
    text: "Explain this",
    selection: "untrusted page text",
  };

  it("preserves a valid prompt and stable request ID", () => {
    expect(parseCommand(JSON.stringify(prompt))).toMatchObject(prompt);
  });
  it.each([
    { ...prompt, text: "" },
    { ...prompt, requestId: "x" },
    { ...prompt, selection: 42 },
    { ...prompt, text: "x".repeat(16001) },
    { ...prompt, selection: "x".repeat(24001) },
    { type: "browser.click", requestId: "request-123" },
    null,
  ])("rejects invalid commands", (command) => {
    expect(() => parseCommand(JSON.stringify(command))).toThrow();
  });
  it("limits frame size before parsing", () => {
    expect(() => parseCommand("x".repeat(60001))).toThrow("too large");
  });
});

describe("external response validation", () => {
  it.each([
    { type: "snapshot", state: { messages: [], busy: "false", partial: "", queued: 0, tools: [] } },
    { type: "ack", requestId: 42 },
    { type: "error", message: { nested: "invalid" } },
    { type: "unknown" },
    null,
  ])("rejects malformed socket events", (event) => {
    expect(EventSchema.safeParse(event).success).toBe(false);
  });
  it("rejects incomplete HTTP responses and malformed saved selections", () => {
    expect(SessionResponseSchema.safeParse({ id: "test" }).success).toBe(false);
    expect(
      SelectionDraftSchema.safeParse({ url: "https://example.com", title: "", selection: 42 })
        .success,
    ).toBe(false);
  });
});
