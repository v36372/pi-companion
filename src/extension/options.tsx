import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { StatusSchema, OAuthStartSchema, ConnectionSchema } from "../shared/protocol.ts";
import { api, backendOrigin, settings, type Settings } from "./settings.ts";
import "./style.css";

function Options() {
  const [backend, setBackend] = useState("http://localhost:8787");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void settings()
      .then((config) => {
        if (config) {
          setBackend(config.backend);
          setToken(config.token);
        }
      })
      .catch((error) => setMessage(String(error)));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setMessage("");

    try {
      const origin = backendOrigin(backend);

      if (token.length < 32) throw new Error("Use a personal token of at least 32 characters");

      // Permission request remains inside the explicit Save gesture.
      if (!(await chrome.permissions.request({ origins: [origin + "/*"] })))
        throw new Error("Worker host access was not granted");
      await chrome.storage.local.set({ settings: { backend: origin, token } satisfies Settings });
      setBackend(origin);
      setMessage("Saved. Check connection or connect Executor below.");
    } catch (e) {
      setMessage(String(e));
    }
  }

  async function operation(kind: "status" | "connect" | "disconnect") {
    setBusy(true);
    setMessage("");

    try {
      const config = await settings();

      if (!config) throw new Error("Save settings first");

      if (kind === "status") {
        const result = await api(config, "/api/status", StatusSchema);

        setMessage(
          "Worker connected · Model " +
            (result.modelConfigured ? "configured" : "not configured") +
            " · Executor " +
            (result.connected ? "linked (credentials stored)" : "not linked"),
        );
      } else if (kind === "connect") {
        const result = await api(config, "/api/oauth/start", OAuthStartSchema, {});

        if (result.url) {
          const url = new URL(result.url);

          if (url.protocol !== "https:")
            throw new Error("Refusing an insecure OAuth authorization URL");
          await chrome.tabs.create({ url: url.href });
          setMessage("Finish connecting in the new tab, then check connection.");
        } else setMessage("Executor is already connected.");
      } else {
        await api(config, "/api/oauth/disconnect", ConnectionSchema, {});
        setMessage(
          "Executor unlinked locally. Revoke its grant in Executor to invalidate existing tokens.",
        );
      }
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="settings">
      <div className="brand">◈ COMPANION</div>
      <h1>Your browser, with continuity.</h1>
      <p>
        One durable conversation per cleaned URL. Your model and Executor credentials stay in your
        backend.
      </p>
      <form onSubmit={save}>
        <label>
          Worker origin
          <input
            value={backend}
            onChange={(e) => setBackend(e.target.value)}
            placeholder="https://companion.example.workers.dev"
            required
          />
        </label>
        <label>
          Personal access token
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            required
            minLength={32}
          />
        </label>
        <p className="muted">
          Use the same COMPANION_TOKEN you configured as a Worker secret. It is stored locally in
          this extension, not synced to Chrome.
        </p>
        <button>Save settings</button>
      </form>
      <h2>Executor MCP</h2>
      <p>
        Sign in through Executor. Access and refresh tokens are held by the credential Durable
        Object, never the extension or transcript.
      </p>
      <div className="buttons">
        <button disabled={busy} onClick={() => operation("connect")}>
          Connect Executor ↗
        </button>
        <button disabled={busy} className="quiet" onClick={() => operation("status")}>
          Check connection
        </button>
        <button disabled={busy} className="quiet" onClick={() => operation("disconnect")}>
          Unlink
        </button>
      </div>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <h2>Privacy & shortcuts</h2>
      <p>
        With chat closed, browsing creates no sessions. An open panel follows the tab’s URL; only
        sending a message starts the agent and shares your question, title, and selected text. Full
        page contents are never captured. Incognito is not supported.
      </p>
      <p>
        Use <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>, or change the shortcut in Chrome’s
        extension shortcuts settings.
      </p>
    </main>
  );
}

const root = document.getElementById("root");

if (!root) throw new Error("Missing settings root element");

createRoot(root).render(<Options />);
