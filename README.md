# Companion

A personal Chrome extension backed by **Pi Durable on Cloudflare or local celld**. The extension is the UI; the agent runs in a Durable Object, not in Chrome's short-lived service worker.

- **One cleaned URL → one session Durable Object.** Two tabs at the same URL share a conversation. Navigate away and back to resume it.
- **Alt+Shift+P** or the toolbar button opens a native, tab-scoped side-panel chat.
- Select text → right-click → **Ask Companion about selection** opens an extension-owned dialog. The selection stays bound to its original URL.
- Conversation and **Executor MCP tools only**. No DOM extraction, browser actions, shell, filesystem tools, or automatic page uploads.
- Executor OAuth with PKCE; access/refresh tokens stay in a separate account Durable Object.
- OpenAI-compatible **Chat Completions** streaming, with base URL, model ID, and API key configured as Worker secrets.

## Local setup

Requires Node 22.19+ (tested on Node 24), pnpm 11, and Chrome 116+.

```sh
pnpm install
cp .dev.vars.example .dev.vars
openssl rand -hex 32
```

Edit `.dev.vars` locally—never commit it:

```dotenv
COMPANION_TOKEN=<generated personal access token>
MODEL_BASE_URL=https://your-provider.example/v1
MODEL_ID=your-model-id
MODEL_API_KEY=<your model API key>
```

The base URL includes the API prefix, usually `/v1`; the client appends `/chat/completions`. Use a tool-capable model. Set its actual `MODEL_CONTEXT_WINDOW` and `MODEL_MAX_TOKENS` in `wrangler.jsonc`; the defaults are 128,000 and 8,192. Reasoning-specific parameters are disabled for compatibility. Reported dollar costs are not configured.

```sh
pnpm dev:worker       # http://localhost:8787; leave running
pnpm build:extension  # in another terminal
```

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `dist/extension`.
2. Open Companion's **Settings**. Save `http://localhost:8787` and your personal access token. Approve access to that Worker host.
3. Choose **Check connection**, then **Connect Executor**. Complete login in the new tab. The callback goes to the Worker's `/oauth/callback` route; the page tells you when it is done.
4. Open an HTTP(S) page and use the toolbar button/hotkey. Configure another key at `chrome://extensions/shortcuts` if Chrome reports a conflict.

`pnpm watch:extension` rebuilds on changes; reload the unpacked extension after changes to the service worker or manifest. Refresh open UI panels after other changes.

OAuth uses dynamic client registration advertised by Executor. If your server's policy refuses localhost callbacks, use the deployed HTTPS Worker instead. An actual sign-in still needs to be completed by you; tests mock the authorization server.

## Local celld + SeaweedFS

```sh
pnpm local:up         # Docker Compose; Companion at http://localhost:9876
# Edit .local/config/worker-vars.json with your model configuration.
pnpm local:deploy
```

The same Worker source is bundled for celld 0.6.2, with SeaweedFS 4.48 as its S3-compatible durable store. See **[setup, verification and compatibility limits](docs/celld.md)**. This is tested application compatibility, not a claim of 1:1 Cloudflare parity or shared data between backends.

## Deploy

Choose a Worker name and set `PUBLIC_ORIGIN` in `wrangler.jsonc` to its actual HTTPS origin. It must be exact: OAuth callback identity is **not** derived from an incoming Host header. The configured MCP URL is:

```text
https://executor.7hkem10.win/mcp?elicitation_mode=model
```

The query requests Executor's conversational approval/input-required flow rather than native MCP elicitation forms.

```sh
pnpm exec wrangler login
pnpm exec wrangler secret put COMPANION_TOKEN
pnpm exec wrangler secret put MODEL_BASE_URL
pnpm exec wrangler secret put MODEL_ID
pnpm exec wrangler secret put MODEL_API_KEY
pnpm deploy
```

Wrangler may offer to create the Worker when you first store a secret. If the assigned hostname differs from `PUBLIC_ORIGIN`, correct it and deploy again **before** connecting Executor. Change the extension settings to that HTTPS origin and sign in.

No deployment or production credentials are included in this repository.

## Session identity

`src/shared/url.ts` is the shared, versioned policy; the backend always computes identity again:

```text
SHA-256("personal:url-v1:" + cleanUrl(tabURL)) → SESSIONS.getByName(hash)
```

Cleaning removes known trackers (`utm_*`, `fbclid`, `gclid`, etc.), plain document anchors, and text-fragment highlights. It preserves meaningful query parameters, their order/encoding/duplicates, path case, trailing slashes, HTTP vs HTTPS, and `#/…`, `#!/…`, or `#key=value` application state. Browser URL parsing also normalizes host casing and default ports. URL credentials and non-HTTP(S) URLs are rejected. It does not fetch redirects or trust a page's `rel=canonical`.

Different query order remains distinct intentionally: aggressive normalization can merge different app states or signed URLs. If an application uses a bare hash as its router, adapt this policy before using it there. Changing the policy requires an identity migration to preserve existing sessions.

There is no browsing-history scanner. With chat closed, navigation creates no objects. While a panel is open it follows navigation and attaches the corresponding session, but only a submitted message starts a model run. Navigating away does not cancel work in the previous URL's object.

## Durability and boundaries

```text
Extension dialog / side panel
  ├─ authenticated HTTPS → Worker → URL Session DO → Pi Durable + SQLite
  └─ short-lived socket ticket → hibernating WebSocket → committed snapshots

URL Session DO → Account DO (token access/serialized refresh) → Executor MCP
```

- Prompts enter Pi's durable inbox before acknowledgement. Messages submitted while busy queue as follow-ups.
- A per-request Chrome local-storage outbox survives panel/browser restarts. Multiple tabs can safely resend the same request ID; Pi deduplicates it.
- Recovery alarms are armed before admitting work. A 60-second heartbeat resumes unfinished tasks even without an open browser. Idle sessions delete their alarms. Both Pi 1.3.0 cache-retention timers are disabled so idle objects can hibernate.
- Reconnection restores committed state, including partial replies. The first UI uses bounded snapshots rather than delta replication. It shows the latest 60 visible messages of the active context, with an 80,000-character overall display budget; the durable transcript is not deleted by this limit.
- MCP discovery is replay-safe. **MCP tool calls are not automatically replayed** after interruption, because the remote action may already have happened. This is not an exactly-once guarantee for external effects. Confirm remote status before retrying a mutation.
- Executor approval/input requests and connection links are relayed in conversation. The agent is instructed to wait for an explicit user reply. This is not an independent application-level approval enforcement system; use Executor's server-side authorization controls for sensitive tools. Native MCP form/URL elicitation, MCP Apps, and local stdio servers are not implemented.
- OAuth state is single-use, expires after ten minutes, and is validated together with the issuer and PKCE verifier. Refreshes are serialized across URL sessions. Changing the configured MCP URL or callback origin invalidates local credentials; reconnect afterwards.

## Security and scope

This is a **single-user starter**, not a multi-tenant service. Possession of `COMPANION_TOKEN` grants access to all its sessions and account-linking operations. Use a random token, protect your Cloudflare account, and configure provider spending limits. There is a connection/queue bound, but no comprehensive billing quota or abuse-rate-limiting layer.

The personal token lives in Chrome local storage, restricted to trusted extension contexts, not sync storage. Model secrets stay in Worker bindings; MCP credentials stay in account-object storage and never appear in conversation snapshots. WebSocket URLs carry only a session-bound, 60-second signed ticket—not the personal token. Tickets are reusable within that brief window. Rotation blocks new authenticated requests/tickets; existing sockets must close to fully revoke a connected viewer.

Page title, cleaned URL, selected text, questions, and tool output can be sensitive. They are stored in the selected backend and sent to the configured model. URLs may still contain sensitive semantic query parameters; don't open Companion on those pages unless you intend to share them. Hashing is an index, **not encryption**. There is no incognito support, full-page capture, cross-URL memory, session deletion/export UI, or automatic retention policy yet.

The UI renders text and HTTP(S) links without interpreting raw HTML. Website code receives no extension messaging API or content script. Optional host permission is requested only for the configured Worker. Unlink removes local MCP tokens; revoke the grant in Executor as well to invalidate already-issued credentials.

## Development and checks

```sh
pnpm lint            # All generic anti-slop rules + no-accumulating-spread
pnpm typecheck
pnpm test             # unit tests + local workerd integration tests; no paid model calls
pnpm check            # lint, types, tests, extension build, Worker deploy dry run
pnpm format

# Optional real Chromium extension smoke test, with a mocked backend:
pnpm exec playwright-core install chromium
pnpm test:browser
# Or use an installed Chromium build supporting --load-extension:
CHROMIUM_PATH=/path/to/chromium pnpm test:browser
```

The smoke test loads the built extension in an isolated browser profile, checks tab-scoped configuration, chat, URL navigation/resume, selection UI, and settings, and writes screenshots to `dist/screenshots/`. It does not automate the OS-native context menu or keyboard shortcut; manually verify those after loading the extension, along with real OAuth and your model endpoint.

Tests cover URL identity, input validation, auth/ticket boundaries, multi-tab outbox behavior, transcript restoration after eviction, recovery from an interrupted model request via an alarm, idle hibernation, OAuth callback validation/refresh, MCP schema discovery and SSE results, and non-retry of ambiguous tool failures. Upstream MCP source maps and local workerd socket teardown may produce warnings.

### Anti-slop

[anti-slop](https://github.com/dmmulroy/anti-slop) is vendored at `tools/oxlint/anti-slop/`, pinned to commit `13909c9e07590f5a85d93c62712259fe14a883f7`. `oxlint.config.ts` enables all 18 generic rules plus `oxc/no-accumulating-spread`; Effect-specific rules are intentionally off because this app has no direct Effect dependency. Oxlint and its plugin API are pinned to 1.88.0. Lint is mandatory in `pnpm check`; `pnpm lint:fix` applies available fixes.

Browser storage, HTTP JSON, commands and socket events are parsed with shared Zod schemas. Types come from schemas or their owning libraries rather than unchecked boundary assertions. Vendored code, nested reference projects and generated files are excluded. Upstream provenance and license files are preserved; compare updates against `tools/oxlint/anti-slop/UPSTREAM.md` rather than overwriting it blindly.

### Layout

- `src/extension/` — Chrome background worker, side-panel/dialog UI, settings, durable outbox.
- `src/shared/` — URL identity and command/event types.
- `src/worker/session.ts` — one Pi harness and SQLite store per URL.
- `src/worker/account.ts` — personal Executor OAuth credential owner.
- `src/worker/mcp.ts` — bounded Streamable HTTP MCP client connections.
- `src/worker/agent.ts` — model configuration and MCP-only tool surface.
- `test/worker/` — real local Durable Object runtime tests with mocked external APIs.

## Reference projects

The sibling `pi/`, `pi-durable-cloudflare/`, and `ultimate/` checkouts are reference material, not runtime dependencies, and have been left unchanged. Companion uses pinned published Pi packages (`1.3.0`), not unreleased APIs in the local Pi checkout.

The Durable Object hosting/recovery approach follows [pi-durable-cloudflare](https://github.com/earendil-works/pi-durable-cloudflare) and Pi Durable's documentation. [Ultimate](https://github.com/HazAT/ultimate) informed the separation between agent behavior and the browser UI; its Node execution environment and coding tools are deliberately not used here.
