import { env } from "cloudflare:workers";
import { reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JSONRPCRequestSchema, type Result } from "@modelcontextprotocol/sdk/types.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { agentOptions } from "../../src/worker/agent.ts";
import { callMcp, discoverMcp } from "../../src/worker/mcp.ts";
import { EventSchema } from "../../src/shared/protocol.ts";

const bindings = env;

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

async function mcpServer(
  failCall = false,
  model?: (request: Request) => Promise<Response>,
  interruptCall?: (signal: AbortSignal) => Promise<void>,
) {
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

    if (new URL(request.url).hostname === "model.test" && model) return model(request);

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
    else if (message.method === "tools/list" && message.params?.cursor === "next-page")
      result = {
        tools: [
          {
            name: "skills",
            description: "Read an app skill",
            inputSchema: { type: "object", properties: { app: { type: "string" } } },
          },
        ],
      };
    else if (message.method === "tools/list")
      result = {
        tools: [
          {
            name: "call",
            description: "Call an app",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false,
            },
            outputSchema: { type: "object", properties: { status: { type: "string" } } },
          },
        ],
        nextCursor: "next-page",
      };
    else if (message.method === "tools/call") {
      await interruptCall?.(request.signal);

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
    const list = await discoverMcp(bindings, new AbortController().signal);
    expect(list.instructions).toContain("executor skill");
    expect(list.tools.map((tool) => tool.name)).toEqual(["call", "skills"]);
    expect(calls.filter((call) => call.method === "tools/list")).toHaveLength(2);

    const result = await callMcp(bindings, new AbortController().signal, "call", {
      path: "app.write",
    });

    expect(result.structuredContent).toEqual({
      status: "approval-required",
      requestId: "apr-test",
    });
    expect(calls.filter((call) => call.method === "tools/call")).toEqual([
      expect.objectContaining({
        params: { name: "call", arguments: { path: "app.write" } },
      }),
    ]);
  });
  it("does not retry a failed tool call with an ambiguous remote outcome", async () => {
    const calls = await mcpServer(true);
    await expect(callMcp(bindings, new AbortController().signal, "call", {})).rejects.toThrow();
    expect(calls.filter((call) => call.method === "tools/call")).toHaveLength(1);
  });
});

function modelResponse(toolArguments?: string): Response {
  const delta =
    toolArguments === undefined
      ? { role: "assistant", content: "Waiting for your confirmation." }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "native-call-1",
              type: "function",
              function: { name: "mcp__executor__call", arguments: toolArguments },
            },
          ],
        };

  const chunk = JSON.stringify({
    id: "chat-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: null }],
  });

  const end = JSON.stringify({
    id: "chat-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: toolArguments === undefined ? "stop" : "tool_calls",
      },
    ],
  });

  return new Response("data: " + chunk + "\n\ndata: " + end + "\n\ndata: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("direct Executor tools", () => {
  it("loads the server catalog after linking and removes tools after disconnecting", async () => {
    const options = agentOptions(bindings);
    await options.refreshTools();
    expect(options.registry.snapshot().tools()).toEqual([]);
    await mcpServer();
    await options.refreshTools();

    const tools = options.registry
      .snapshot()
      .tools()
      .map(({ tool }) => tool);

    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp__executor__call",
      "mcp__executor__skills",
    ]);
    expect(tools[0].description).toBe("Call an app");
    expect(tools[0].parameters).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    });
    expect(tools.every((tool) => tool.replay === "unsafe")).toBe(true);

    await bindings.ACCOUNT.getByName("personal").disconnect();
    await options.refreshTools();
    expect(options.registry.snapshot().tools()).toEqual([]);
  });

  it.each(["valid", "invalid"])(
    "offers native schemas to the model and validates %s arguments before calling Executor",
    async (mode) => {
      const modelRequests: unknown[] = [];

      const calls = await mcpServer(false, async (request) => {
        modelRequests.push(await request.json());

        return modelRequests.length === 1
          ? modelResponse(JSON.stringify(mode === "valid" ? { path: "app.write" } : {}))
          : modelResponse();
      });

      const options = agentOptions(bindings);
      await options.refreshTools();
      const harness = await Harness.open(new MemoryStorage(), options, context);

      try {
        const root = await harness.root(context, {
          agent: { model: { provider: "configured", modelId: bindings.MODEL_ID } },
        });

        const submission = await root.submit({ type: "input", content: "Call the app" }, context);
        expect((await submission.wait(context)).status).toBe("done");
        expect(modelRequests).toHaveLength(2);
        expect(modelRequests[0]).toEqual(
          expect.objectContaining({
            tools: expect.arrayContaining([
              expect.objectContaining({
                function: expect.objectContaining({
                  name: "mcp__executor__call",
                  description: "Call an app",
                  parameters: expect.objectContaining({ required: ["path"] }),
                }),
              }),
              expect.objectContaining({
                function: expect.objectContaining({ name: "mcp__executor__skills" }),
              }),
            ]),
          }),
        );
        expect(JSON.stringify(modelRequests[0])).toContain("Read the executor skill first.");
        expect(JSON.stringify(modelRequests[0])).not.toContain("mcp_list_tools");
        expect(JSON.stringify(modelRequests[0])).not.toContain("mcp_call_tool");
        expect(JSON.stringify(modelRequests[0])).not.toContain("test-access");

        const toolCalls = calls.filter((call) => call.method === "tools/call");
        expect(toolCalls).toHaveLength(mode === "valid" ? 1 : 0);

        if (mode === "valid") {
          expect(toolCalls[0].params).toEqual({ name: "call", arguments: { path: "app.write" } });
          expect(JSON.stringify(modelRequests[1])).toContain("approval-required");
          expect(JSON.stringify(modelRequests[1])).toContain("apr-test");
        } else expect(JSON.stringify(modelRequests[1])).toContain("Validation failed");
      } finally {
        await harness.close(context);
      }
    },
  );

  it("uses tools linked after a session opened and discovers them again after eviction", async () => {
    const stub = bindings.SESSIONS.getByName("native-executor-tools");
    await stub.bindUrl("https://page.test/native-tools");
    const modelRequests: unknown[] = [];

    const calls = await mcpServer(false, async (request) => {
      modelRequests.push(await request.json());

      return modelRequests.length % 2 === 1
        ? modelResponse(JSON.stringify({ path: "app.write" }))
        : modelResponse();
    });

    for (const requestId of ["before-eviction", "after-eviction"]) {
      const response = await stub.fetch(
        new Request("https://internal/socket", { headers: { Upgrade: "websocket" } }),
      );

      const socket = response.webSocket;

      if (!socket) throw new Error("Expected a WebSocket upgrade");

      const done = new Promise<void>((resolve, reject) => {
        socket.addEventListener("message", (event) => {
          const message = EventSchema.parse(JSON.parse(String(event.data)));

          if (message.type === "error") reject(new Error(message.message));

          if (
            message.type === "snapshot" &&
            !message.state.busy &&
            message.state.messages.some(
              (item) => item.role === "user" && item.text === requestId,
            ) &&
            message.state.messages.at(-1)?.role === "assistant"
          )
            resolve();
        });
      });

      socket.accept();
      socket.send(JSON.stringify({ type: "prompt", requestId, text: requestId }));
      await done;
      socket.close(1000);
      await evictDurableObject(stub, { webSockets: "close" });
    }

    expect(calls.filter((call) => call.method === "tools/call")).toHaveLength(2);
    expect(modelRequests).toHaveLength(4);
    expect(JSON.stringify(modelRequests[2])).toContain("mcp__executor__call");
  });

  it("does not replay an interrupted native tool call after reopening storage", async () => {
    const started = Promise.withResolvers<void>();
    const modelRequests: unknown[] = [];

    const calls = await mcpServer(
      false,
      async (request) => {
        modelRequests.push(await request.json());

        return modelRequests.length === 1
          ? modelResponse(JSON.stringify({ path: "app.write" }))
          : modelResponse();
      },
      async (signal) => {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Interrupted", "AbortError"));

          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    );

    await runInDurableObject(
      bindings.ACCOUNT.getByName("agent-recovery"),
      async (_instance, state) => {
        const options = agentOptions(bindings);
        await options.refreshTools();

        const harness = await Harness.open(
          await openDurableObjectSqliteStorage(state.storage),
          options,
          context,
        );

        try {
          const root = await harness.root(context, {
            agent: { model: { provider: "configured", modelId: bindings.MODEL_ID } },
          });

          await root.submit(
            { type: "input", requestId: "interrupted-native-call", content: "Call the app" },
            context,
          );
          await started.promise;
        } finally {
          await harness.close(context);
        }

        const restoredOptions = agentOptions(bindings);
        await restoredOptions.refreshTools();

        const restored = await Harness.open(
          await openDurableObjectSqliteStorage(state.storage),
          restoredOptions,
          context,
        );

        try {
          const root = await restored.root(context);

          const submission = await root.submit(
            { type: "input", requestId: "interrupted-native-call", content: "Call the app" },
            context,
          );

          expect((await submission.wait(context)).status).toBe("done");
        } finally {
          await restored.close(context);
        }
      },
    );
    expect(calls.filter((call) => call.method === "tools/call")).toHaveLength(1);
    expect(modelRequests).toHaveLength(2);
    expect(JSON.stringify(modelRequests[1])).toContain("interrupted");
  });
});
