import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { cleanUrl, sessionKey } from "../shared/url.ts";
import { SelectionDraftSchema, type Snapshot } from "../shared/protocol.ts";
import { settings, type SelectionDraft } from "./settings.ts";
import { SessionClient } from "./client.ts";
import "./style.css";

const empty: Snapshot = { messages: [], partial: "", busy: false, queued: 0, tools: [] };
const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tabId"));
const selectionId = params.get("selection");

/** Safe text and HTTP(S) links only; never interpret model/page text as HTML. */
function Text({ value }: { value: string }) {
  return (
    <>
      {value.split(/(https?:\/\/[^\s<>"“”]+)/g).map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

function App() {
  const [page, setPage] = useState<SelectionDraft>();
  const [state, setState] = useState<Snapshot>(empty);
  const [status, setStatus] = useState("Open an HTTP(S) page");
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [selection, setSelection] = useState("");
  const [sending, setSending] = useState(false);
  const [revision, setRevision] = useState(0);
  const client = useRef<SessionClient>(undefined);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    let observedTabId = params.has("tabId") ? tabId : undefined;
    let observedWindowId: number | undefined;

    const update = (tab: chrome.tabs.Tab) => {
      if (!alive) return;

      try {
        observedTabId = tab.id;
        observedWindowId = tab.windowId;

        if (tab.incognito) throw new Error("Incognito sessions are disabled");
        setPage({
          url: cleanUrl(tab.url ?? ""),
          title: (tab.title ?? "").slice(0, 1000),
          selection: "",
        });
      } catch (e) {
        setPage(undefined);
        setError(String(e));
      }
    };

    if (selectionId) {
      void chrome.storage.session
        .get("selection:" + selectionId)
        .then((data) => {
          const captured = SelectionDraftSchema.optional().parse(data["selection:" + selectionId]);

          if (!alive || !captured) return;
          setPage({ ...captured, url: cleanUrl(captured.url) });
          setSelection(captured.selection);
        })
        .catch((error) => {
          if (alive) setError(String(error));
        });
    } else if (params.has("tabId")) {
      void chrome.tabs
        .get(tabId)
        .then(update)
        .catch(() => setError("This tab has closed"));
    } else {
      // The default global panel is used only before Chrome installs a tab-specific configuration.
      void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        if (tabs[0]) update(tabs[0]);
      });
    }

    const onUpdated = (id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (!selectionId && id === observedTabId && (change.url || change.title)) update(tab);
    };

    const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
      if (!selectionId && !params.has("tabId") && info.windowId === observedWindowId) {
        void chrome.tabs
          .get(info.tabId)
          .then(update)
          .catch(() => setPage(undefined));
      }
    };

    const onRemoved = (id: number) => {
      if (!selectionId && id === observedTabId) setPage(undefined);
    };

    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      // Only settings changes should reconnect; outbox writes are frequent.
      if (area === "local" && "settings" in changes) setRevision((n) => n + 1);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.storage.onChanged.addListener(onStorage);

    return () => {
      alive = false;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setState(empty);
    setError("");
    setText("");
    client.current?.close();
    client.current = undefined;

    if (!page) return;
    void (async () => {
      const config = await settings();

      if (!alive) return;

      if (!config?.token) {
        setError("Open Settings to connect your Worker.");

        return;
      }

      const key = await sessionKey(page.url);

      if (!alive) return;

      const connection = new SessionClient(
        config,
        page.url,
        "outbox:" + config.backend + ":" + key,
        (next) => {
          if (alive) setState(next);
        },
        (next) => {
          if (alive) setStatus(next);
        },
        (next) => {
          if (alive) setError(next);
        },
      );

      client.current = connection;
      await connection.start();
    })().catch((e) => {
      if (alive) setError(String(e));
    });

    return () => {
      alive = false;
      client.current?.close();
      client.current = undefined;
    };
  }, [page?.url, revision]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages.length, state.partial]);

  async function submit(event: FormEvent) {
    event.preventDefault();

    if (!text.trim() || !page || !client.current || sending) return;
    const connection = client.current;
    setSending(true);
    setError("");

    try {
      await connection.send(text, page.title, selection || undefined);

      if (client.current === connection) {
        setText("");
        setSelection("");
      }

      if (selectionId)
        await chrome.storage.session.set({
          ["selection:" + selectionId]: { url: page.url, title: page.title, selection: "" },
        });
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="chat">
      <header>
        <div>
          <strong>◈ Companion</strong>
          <small>{status}</small>
        </div>
        <button className="quiet" onClick={() => chrome.runtime.openOptionsPage()}>
          Settings
        </button>
      </header>
      <div className="page" title={page?.url}>
        {page?.url ?? "No supported page"}
      </div>
      {error && (
        <div role="alert" className="error">
          {error}
          <button
            className="quiet"
            onClick={() => {
              setError("");
              setRevision((n) => n + 1);
            }}
          >
            Retry
          </button>
          <button
            className="quiet"
            onClick={() => {
              if (
                confirm(
                  "Discard locally queued messages for this URL? Messages already accepted by the server are not deleted.",
                )
              ) {
                void client.current
                  ?.discardPending()
                  .then(() => setError(""))
                  .catch((e) => setError(String(e)));
              }
            }}
          >
            Discard unsent
          </button>
        </div>
      )}
      <section className="transcript" aria-live="polite">
        {!state.messages.length && !state.busy && (
          <div className="empty">
            <h1>A conversation for this page.</h1>
            <p>
              Ask a question, or select text and right-click to bring it here. Returning to this URL
              brings back this conversation.
            </p>
            <p>Only what you send is shared. No page-reading or browser-action tools.</p>
          </div>
        )}
        {state.messages.map((message) =>
          message.role === "tool" ? (
            <details key={message.id} className={message.error ? "tool error" : "tool"}>
              <summary>MCP result{message.error ? " · error" : ""}</summary>
              <pre>
                <Text value={message.text} />
              </pre>
            </details>
          ) : (
            <article key={message.id} className={message.role + (message.error ? " error" : "")}>
              <label>{message.role === "user" ? "You" : "Companion"}</label>
              <div className="message">
                <Text value={message.text} />
              </div>
            </article>
          ),
        )}
        {state.partial && (
          <article className="assistant">
            <label>Companion</label>
            <div className="message">
              <Text value={state.partial} />
            </div>
          </article>
        )}
        {state.busy && (
          <p className="working">
            {state.tools.length ? "Using MCP…" : "Thinking…"}
            {state.queued ? " · " + state.queued + " queued" : ""}
          </p>
        )}
        <div ref={bottom} />
      </section>
      <form onSubmit={submit}>
        {selection && (
          <div className="selection">
            <button
              type="button"
              onClick={() => setSelection("")}
              aria-label="Remove selected text"
            >
              ×
            </button>
            {selection.slice(0, 320)}
            {selection.length > 320 ? "…" : ""}
          </div>
        )}
        <textarea
          aria-label="Message"
          placeholder={selection ? "Ask about this selection…" : "Ask Companion…"}
          value={text}
          maxLength={16000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <footer>
          <span>
            {state.busy
              ? "Messages queue while working"
              : "Enter to send · Shift+Enter for a new line"}
          </span>
          {state.busy && (
            <button
              type="button"
              className="quiet"
              onClick={() => {
                try {
                  client.current?.stopTurn();
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              Stop
            </button>
          )}
          <button disabled={!page || !text.trim() || sending || !client.current}>Send ↗</button>
        </footer>
      </form>
    </main>
  );
}

const root = document.getElementById("root");

if (!root) throw new Error("Missing chat root element");

createRoot(root).render(<App />);
