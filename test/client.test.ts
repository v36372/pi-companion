import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { SessionClient } from "../src/extension/client.ts";
import type { Prompt } from "../src/shared/protocol.ts";

class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  constructor(readonly url: string) {
    Socket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  ack(requestId: string) {
    this.onmessage?.({ data: JSON.stringify({ type: "ack", requestId }) });
  }
}

let records: Record<string, Prompt>;

type StorageListener = Parameters<typeof chrome.storage.onChanged.addListener>[0];

let listeners: Set<StorageListener>;
const config = { backend: "https://worker.test", token: "test-personal-token" };
const clients: SessionClient[] = [];

function client(key = "outbox:shared-url") {
  const value = new SessionClient(
    config,
    "https://page.test/article",
    key,
    vi.fn(),
    vi.fn(),
    vi.fn(),
  );

  clients.push(value);

  return value;
}

beforeEach(() => {
  records = {};
  listeners = new Set();
  Socket.all = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ id: "session", ticket: "ticket", canonicalUrl: "https://page.test/article" }),
    ),
  );
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async () => ({ ...records }),
        set: async (values: Record<string, Prompt>) => {
          Object.assign(records, values);

          const changes = Object.fromEntries(
            Object.entries(values).map(([k, newValue]) => [k, { newValue }]),
          );

          for (const listener of listeners) listener(changes, "local");
        },
        remove: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];

          for (const key of list) delete records[key];

          for (const listener of listeners)
            listener(Object.fromEntries(list.map((key) => [key, {}])), "local");
        },
      },
      onChanged: {
        addListener: (fn: StorageListener) => listeners.add(fn),
        removeListener: (fn: StorageListener) => listeners.delete(fn),
      },
    },
  });
});

afterEach(() => {
  for (const value of clients.splice(0)) value.close();
  vi.unstubAllGlobals();
});

describe("durable browser outbox", () => {
  it("retains an unacknowledged request across panel/browser restarts using the same ID", async () => {
    const first = client();
    await first.start();
    Socket.all[0].open();
    await first.send("Hello", "Page", "Quote");
    const sent = JSON.parse(Socket.all[0].sent[0]);
    expect(Object.values(records)).toContainEqual(sent);
    first.close();
    const reopened = client();
    await reopened.start();
    Socket.all[1].open();
    expect(JSON.parse(Socket.all[1].sent[0])).toEqual(sent);
    Socket.all[1].ack(sent.requestId);
    expect(records).toEqual({});
    expect(Socket.all[1].url).not.toContain(config.token);
  });
  it("stores concurrent tabs' messages independently instead of overwriting a shared array", async () => {
    const a = client(),
      b = client();

    await Promise.all([a.start(), b.start()]);
    Socket.all.forEach((socket) => socket.open());
    await Promise.all([a.send("One", "Page"), b.send("Two", "Page")]);
    expect(Object.values(records)).toHaveLength(2);
    expect(Socket.all[0].sent.map((s) => JSON.parse(s).text)).toEqual(["One", "Two"]);
    expect(Socket.all[1].sent.map((s) => JSON.parse(s).text)).toEqual(["One", "Two"]);
  });
  it("rejects malformed server acknowledgements without deleting the outbox", async () => {
    const value = client();
    await value.start();
    Socket.all[0].open();
    await value.send("Keep until a valid receipt", "Page");
    Socket.all[0].onmessage?.({ data: JSON.stringify({ type: "ack", requestId: 42 }) });
    expect(Object.keys(records)).toHaveLength(1);
    expect(Socket.all[0].readyState).toBe(3);
  });

  it("does not send a different URL's queued message and keeps rejected messages", async () => {
    const a = client();
    await a.start();
    Socket.all[0].open();
    await a.send("Keep me", "Page");
    const sent = JSON.parse(Socket.all[0].sent[0]);
    Socket.all[0].onmessage?.({
      data: JSON.stringify({
        type: "error",
        requestId: sent.requestId,
        message: "Configure the model",
      }),
    });
    a.close();
    const other = client("outbox:other-url");
    await other.start();
    Socket.all[1].open();
    expect(Socket.all[1].sent).toEqual([]);
    expect(Object.keys(records)).toHaveLength(1);
  });
});
