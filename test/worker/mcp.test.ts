import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JSONRPCRequestSchema, type Result } from "@modelcontextprotocol/sdk/types.js";
import { callMcp, listMcp } from "../../src/worker/mcp.ts";

const bindings = env;

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

async function mcpServer(failCall = false) {
  await runInDurableObject(bindings.ACCOUNT.getByName("personal"), async (instance, state) => {
    await instance.status();
    await state.storage.put("tokens", {
      value: { access_token: "test-access", token_type: "Bearer" },
      expires: Date.now() + 3600000,
    });
  });
  const calls: Array<ReturnType<typeof JSONRPCRequestSchema.parse>> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(request.headers.get("Authorization")).toBe("Bearer test-access");
    expect(new URL(request.url).searchParams.get("elicitation_mode")).toBe("model");

    if (request.method === "GET") return new Response(null, { status: 405 });
    const message = JSONRPCRequestSchema.partial({ id: true }).parse(await request.json());

    if (message.id === undefined) return new Response(null, { status: 202 });
    calls.push({ ...message, id: message.id });
    let result: Result;

    if (message.method === "initialize")
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "Executor", version: "test" },
        instructions: "Read the executor skill first.",
      };
    else if (message.method === "tools/list")
      result = {
        tools: [
          {
            name: "executor_call",
            description: "Call an app",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
            outputSchema: { type: "object", properties: { status: { type: "string" } } },
          },
        ],
        nextCursor: "next-page",
      };
    else if (message.method === "tools/call") {
      if (failCall) return new Response("Unknown outcome", { status: 503 });
      result = {
        content: [{ type: "text", text: "Ask the user" }],
        structuredContent: { status: "approval-required", requestId: "apr-test" },
      };
    } else throw new Error("Unexpected MCP method");

    // Exercise Streamable HTTP SSE responses, not just JSON responses.
    return new Response(
      "event: message\ndata: " +
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) +
        "\n\n",
      {
        headers: { "Content-Type": "text/event-stream" },
      },
    );
  });

  return calls;
}

describe("MCP bridge", () => {
  it("discovers schemas, pagination, and instructions and relays approval results without accepting them", async () => {
    const calls = await mcpServer();
    const list = await listMcp(bindings, new AbortController().signal);
    expect(list.instructions).toContain("executor skill");
    expect(list.nextCursor).toBe("next-page");
    expect(list.tools[0].name).toBe("executor_call");

    const result = await callMcp(bindings, new AbortController().signal, "executor_call", {
      path: "app.write",
    });

    expect(result.structuredContent).toEqual({
      status: "approval-required",
      requestId: "apr-test",
    });
    expect(calls.filter((call) => call.method === "tools/call")).toEqual([
      expect.objectContaining({
        params: { name: "executor_call", arguments: { path: "app.write" } },
      }),
    ]);
  });
  it("does not retry a failed tool call with an ambiguous remote outcome", async () => {
    const calls = await mcpServer(true);
    await expect(
      callMcp(bindings, new AbortController().signal, "executor_call", {}),
    ).rejects.toThrow();
    expect(calls.filter((call) => call.method === "tools/call")).toHaveLength(1);
  });
});
