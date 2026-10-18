import type { Prompt, Snapshot } from "../shared/protocol.ts";
import { z } from "zod";
import {
  EventSchema,
  PromptSchema,
  SessionLookupResponseSchema,
  parseCommand,
} from "../shared/protocol.ts";
import { api, type Settings } from "./settings.ts";

/** One durable record per request, shared across tabs. Never depend on Chrome's ephemeral tab IDs. */
export class SessionClient {
  private socket?: WebSocket;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private retry = 0;
  private pending = new Map<string, Prompt>();
  private create = false;
  private ready = false;
  private connecting?: Promise<void>;
  constructor(
    private config: Settings,
    private url: string,
    private outbox: string,
    private onState: (state: Snapshot) => void,
    private onStatus: (status: string) => void,
    private onError: (error: string) => void,
  ) {}
  private key(id: string) {
    return this.outbox + ":" + id;
  }
  private remember(key: string, command: Prompt) {
    if (key !== this.key(command.requestId) || this.pending.has(command.requestId)) return;
    this.pending.set(command.requestId, command);
    this.create = true;

    if (this.stopped) return;

    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(command));
    else if (this.ready) void this.connect();
  }
  private storageChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== "local" || this.stopped) return;

    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(this.outbox + ":")) continue;

      if (change.newValue === undefined) this.pending.delete(key.slice(this.outbox.length + 1));
      else {
        const parsed = PromptSchema.safeParse(change.newValue);

        if (parsed.success) this.remember(key, parsed.data);
        else
          this.onError(
            "An invalid saved message was ignored. Discard unsent messages to clear it.",
          );
      }
    }
  };
  async start(create = false) {
    this.create = create;
    chrome.storage.onChanged.addListener(this.storageChanged);
    const records = await chrome.storage.local.get(null);

    if (this.stopped) return;

    for (const [key, value] of Object.entries(records)) {
      if (!key.startsWith(this.outbox + ":")) continue;
      const parsed = PromptSchema.safeParse(value);

      if (parsed.success) this.remember(key, parsed.data);
      else
        this.onError("An invalid saved message was ignored. Discard unsent messages to clear it.");
    }

    this.ready = true;
    await this.connect();
  }
  private connect(): Promise<void> {
    if (
      this.stopped ||
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    )
      return Promise.resolve();
    clearTimeout(this.timer);
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }
  private async open(): Promise<void> {
    try {
      this.onStatus("Connecting…");

      const create = this.create;

      const session = await api(this.config, "/api/sessions", SessionLookupResponseSchema, {
        url: this.url,
        create,
      });

      if (this.stopped) return;

      if (!session) {
        // A send can arrive while the read-only lookup is in flight. Upgrade that lookup once.
        if (!create && this.create) return this.open();

        if (create) throw new Error("The server did not create the session");
        this.onStatus("Ready");

        return;
      }

      this.create = true;
      const endpoint = new URL(this.config.backend + "/api/sessions/" + session.id + "/socket");
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      endpoint.searchParams.set("ticket", session.ticket);
      const socket = (this.socket = new WebSocket(endpoint));
      socket.onopen = () => {
        if (this.stopped) {
          socket.close();

          return;
        }

        this.retry = 0;
        this.onStatus("Connected");

        for (const command of this.pending.values()) socket.send(JSON.stringify(command));
      };

      socket.onmessage = (event) => {
        if (this.stopped) return;
        let message;

        try {
          message = EventSchema.parse(JSON.parse(z.string().parse(event.data)));
        } catch {
          this.onError("The server sent an invalid message");
          socket.close(1002, "Invalid message");

          return;
        }

        if (message.type === "snapshot") this.onState(message.state);

        if (message.type === "ack") {
          this.pending.delete(message.requestId);
          void chrome.storage.local
            .remove(this.key(message.requestId))
            .catch(() => this.onError("Could not save the outbox acknowledgement"));
        }

        if (message.type === "error")
          this.onError(
            message.message +
              (message.requestId ? " · Message retained; fix the error and Retry." : ""),
          );
      };

      socket.onclose = () => this.reconnect();
      socket.onerror = () => socket.close();
    } catch (error) {
      if (this.stopped) return;
      this.onError(error instanceof Error ? error.message : "Connection failed");
      this.reconnect();
    }
  }
  private reconnect() {
    if (this.stopped) return;
    this.onStatus("Reconnecting…");
    this.timer = setTimeout(
      () => {
        void this.connect();
      },
      Math.min(30000, 1000 * 2 ** this.retry++) + Math.random() * 500,
    );
  }
  async send(text: string, title: string, selection?: string) {
    if (this.stopped) throw new Error("Page changed; send from its current conversation");

    if (this.pending.size >= 10)
      throw new Error("Too many unsent messages. Reconnect before sending more.");

    const command: Prompt = {
      type: "prompt",
      requestId: crypto.randomUUID(),
      text,
      title,
    };

    if (selection) command.selection = selection;

    parseCommand(JSON.stringify(command));
    // Persist before sending. Other panels may send it too; the server deduplicates by request ID.
    await chrome.storage.local.set({ [this.key(command.requestId)]: command });

    if (!this.stopped) this.remember(this.key(command.requestId), command);
  }
  async discardPending() {
    const records = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(
      Object.keys(records).filter((key) => key.startsWith(this.outbox + ":")),
    );
    this.pending.clear();
  }
  stopTurn() {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Reconnect before stopping");
    this.socket.send(JSON.stringify({ type: "stop", requestId: crypto.randomUUID() }));
  }
  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    chrome.storage.onChanged.removeListener(this.storageChanged);
    this.socket?.close();
  }
}
