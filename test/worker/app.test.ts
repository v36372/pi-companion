import { env } from "cloudflare:workers";
import {
  reset,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { agentOptions } from "../../src/worker/agent.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index.ts";
import {
  SessionResponseSchema,
  EventSchema,
  type Event,
  type Snapshot,
  type JsonValue,
} from "../../src/shared/protocol.ts";

const bindings = env;

const headers = {
  Authorization: "Bearer test-personal-token-with-at-least-32-characters",
  "Content-Type": "application/json",
};

function request(path: string, body?: JsonValue) {
  const init: RequestInit = { method: body === undefined ? "GET" : "POST", headers };

  if (body !== undefined) init.body = JSON.stringify(body);

  return worker.fetch(new Request("https://companion.test" + path, init), bindings);
}

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

async function resolve(url: string) {
  const response = await request("/api/sessions", { url });
  expect(response.status).toBe(200);

  return SessionResponseSchema.parse(await response.json());
}

async function connect(session: { id: string; ticket: string }) {
  const response = await worker.fetch(
    new Request(
      "https://companion.test/api/sessions/" + session.id + "/socket?ticket=" + session.ticket,
      {
        headers: { Upgrade: "websocket" },
      },
    ),
    bindings,
  );

  expect(response.status).toBe(101);
  const socket = response.webSocket;

  if (!socket) throw new Error("Expected a WebSocket upgrade");
  const queued: Event[] = [];
  const waiting: Array<(event: Event) => void> = [];
  socket.addEventListener("message", (event) => {
    const value = EventSchema.parse(JSON.parse(String(event.data)));
    const resolve = waiting.shift();

    if (resolve) resolve(value);
    else queued.push(value);
  });
  socket.accept();

  async function next(): Promise<Event> {
    return queued.shift() ?? new Promise((resolve) => waiting.push(resolve));
  }

  async function snapshot(predicate: (state: Snapshot) => boolean): Promise<Snapshot> {
    for (;;) {
      const e = await next();

      if (e.type === "snapshot" && predicate(e.state)) return e.state;
    }
  }

  return { socket, next, snapshot };
}

function mockModel(interruptFirst?: (signal: AbortSignal | null | undefined) => Promise<void>) {
  const requests: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);

    if (!url.startsWith("https://model.test/"))
      throw new Error("Unexpected network request: " + url);
    requests.push(JSON.parse(String(init?.body)));

    if (requests.length === 1 && interruptFirst) await interruptFirst(init?.signal);

    const chunk = (
      delta: { role?: "assistant"; content?: string },
      finish_reason: string | null = null,
    ) =>
      "data: " +
      JSON.stringify({
        id: "chat-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason }],
      }) +
      "\n\n";

    return new Response(
      chunk({ role: "assistant", content: "Hello from the durable agent." }) +
        chunk({}, "stop") +
        "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });

  return requests;
}

describe("personal durable sessions", () => {
  it("rejects unauthenticated calls and forged socket tickets", async () => {
    expect(
      (await worker.fetch(new Request("https://test/api/sessions", { method: "POST" }), bindings))
        .status,
    ).toBe(401);
    expect((await request("/api/sessions/" + "a".repeat(64) + "/socket?ticket=fake")).status).toBe(
      426,
    );
    expect(
      (
        await worker.fetch(
          new Request(
            "https://companion.test/api/sessions/" + "a".repeat(64) + "/socket?ticket=fake",
            { headers: { Upgrade: "websocket" } },
          ),
          bindings,
        )
      ).status,
    ).toBe(401);
    expect((await request("/api/sessions", { url: "file:///secret" })).status).toBe(400);
  });
  it("shares cleaned URLs and separates different URLs", async () => {
    const first = await resolve("https://page.test/a?utm_source=mail");
    const second = await resolve("https://page.test/a");
    const other = await resolve("https://page.test/b");
    expect(first.id).toBe(second.id);
    expect(first.id).not.toBe(other.id);

    const a = await connect(first),
      b = await connect(second);

    expect((await a.next()).type).toBe("snapshot");
    expect((await b.next()).type).toBe("snapshot");
    a.socket.close(1000);
    b.socket.close(1000);
  });
  it("streams to two tabs, deduplicates retries, and restores the transcript after eviction", async () => {
    const modelRequests = mockModel();
    const session = await resolve("https://page.test/article");

    const a = await connect(session),
      b = await connect(session);

    const prompt = {
      type: "prompt",
      requestId: "durable-request-1",
      text: "Explain this",
      selection: "Selected quotation",
      title: "Article",
    };

    a.socket.send(JSON.stringify(prompt));
    const done = await b.snapshot((s) => !s.busy && s.messages.some((m) => m.role === "assistant"));
    expect(done.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(done.messages.find((m) => m.role === "assistant")?.text).toContain("durable agent");
    a.socket.send(JSON.stringify(prompt));

    for (;;) {
      const event = await a.next();

      if (event.type === "ack" && event.requestId === prompt.requestId) break;
    }

    // Consume the original receipt and the retry receipt before evicting.
    for (;;) {
      const event = await a.next();

      if (event.type === "ack" && event.requestId === prompt.requestId) break;
    }

    a.socket.close(1000);
    b.socket.close(1000);
    await evictDurableObject(bindings.SESSIONS.getByName(session.id));
    const resolved = await resolve("https://page.test/article");
    const restored = await connect(resolved);
    const snapshot = await restored.snapshot((s) => s.messages.some((m) => m.role === "assistant"));
    expect(snapshot.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(JSON.stringify(modelRequests[0])).toContain("Selected quotation");
    expect(JSON.stringify(modelRequests[0])).not.toContain("test-key");
    expect(modelRequests).toHaveLength(1);
    restored.socket.close(1000);
  });
  it("recovers unfinished work from its alarm without a connected browser", async () => {
    const started = Promise.withResolvers<void>();

    const modelRequests = mockModel(async (signal) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Interrupted", "AbortError"));

        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    });

    const session = await resolve("https://page.test/recover");
    const stub = bindings.SESSIONS.getByName(session.id);
    // Seed the interrupted process with exactly one storage owner. Closing leaves work pending,
    // unlike abort(). The next real Session instance must resume it from its alarm.
    await runInDurableObject(stub, async (instance, state) => {
      // Test-only inspection closes the existing private harness before taking over its SQLite owner.
      await instance["harness"].close(BACKGROUND_CONTEXT);

      const harness = await Harness.open(
        await openDurableObjectSqliteStorage(state.storage),
        agentOptions(bindings),
        BACKGROUND_CONTEXT,
      );

      try {
        const root = await harness.root(BACKGROUND_CONTEXT);
        await root.submit(
          { type: "input", requestId: "recover-request-1", content: "Continue after a restart" },
          BACKGROUND_CONTEXT,
        );
        await started.promise;
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
      }

      await state.storage.setAlarm(Date.now() + 60000);
    });
    await evictDurableObject(stub, { webSockets: "close" });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    // Observation attaches only after the alarm has resumed the pending run.
    const restored = await connect(session);

    const state = await restored.snapshot(
      (s) => !s.busy && s.messages.some((m) => m.role === "assistant"),
    );

    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(modelRequests).toHaveLength(2);
    restored.socket.close(1000);
  });
  it("leaves no recovery alarm while idle", async () => {
    const session = await resolve("https://page.test/idle");

    const alarm = await runInDurableObject(
      bindings.SESSIONS.getByName(session.id),
      async (_instance, state) => state.storage.getAlarm(),
    );

    expect(alarm).toBeNull();
  });
});
