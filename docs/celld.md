# Local celld + SeaweedFS

## Run

Requires Linux x64/arm64, Docker with Compose, Node 22.19+ and pnpm. This runner installs a **project-local celld 0.6.2**, verifies the release archive SHA-256, and does not replace a system celld installation. SeaweedFS is pinned to **4.48** and an image digest in `compose.local.yaml`.

```sh
pnpm install
pnpm local:up
pnpm build:extension
```

`local:up` creates random S3 credentials and a personal bearer token, starts SeaweedFS, creates its `companion` bucket, checks conditional-write semantics with `celld diagnose`, bundles the actual Worker, uploads it, and starts celld. It is safe to run again; it does not clear existing data.

Edit **`.local/config/worker-vars.json`** locally:

```json
{
  "COMPANION_TOKEN": "keep-the-generated-token",
  "MODEL_BASE_URL": "https://your-provider.example/v1",
  "MODEL_ID": "your-tool-capable-model",
  "MODEL_API_KEY": "your-key"
}
```

Then:

```sh
pnpm local:deploy
```

Load `dist/extension` in Chrome, and save **`http://localhost:9876`** plus the token from that private file in Companion settings. Connect Executor in the browser. Model and real Executor credentials are not supplied by the test fixtures. If Executor refuses a localhost redirect, use an HTTPS origin with a correctly configured proxy and update `PUBLIC_ORIGIN` in the private vars file before connecting.

Normal deployment retains `https://executor.7hkem10.win/mcp?elicitation_mode=model`. You can override `MCP_URL`, `PUBLIC_ORIGIN`, and model limits in the private vars file. Changing the MCP URL or callback origin invalidates stored OAuth credentials.

## Commands and storage

```sh
pnpm local:diagnose
pnpm local:deploy
pnpm local:down           # Stops containers; retains named volumes

docker compose -f compose.local.yaml ps
docker compose -f compose.local.yaml logs --tail=100 celld
```

| Item                                      | Location                                           |
| ----------------------------------------- | -------------------------------------------------- |
| Companion HTTP / WebSockets               | `http://localhost:9876`                            |
| Private operator API, **unauthenticated** | `http://localhost:9877`                            |
| Authenticated S3 endpoint                 | `http://localhost:8333`                            |
| Personal token/model settings             | `.local/config/worker-vars.json`                   |
| S3 credentials                            | `.local/config/celld.env`, `.local/config/s3.json` |
| Generated celld deployment config         | `wrangler.celld.local.json`                        |
| Authoritative SeaweedFS data              | Docker volume `companion-local_seaweed-data`       |
| Rebuildable celld cache                   | Docker volume `companion-local_celld-cache`        |

All published ports bind only to `127.0.0.1`. Do not expose the operator API or S3 listener publicly. Containers use `restart: unless-stopped`; Docker must be running. `CELLD_DURABILITY=bucket` makes acknowledgements wait for bucket persistence. Idle cells can hibernate after 30 seconds.

`CELLD_WAKER_TICK_MS=5000` selects a five-second orphan-alarm scan. celld's default is 60 seconds, with an advisory waker lease lasting three scan intervals; after SIGKILL, takeover can therefore exceed the application's 60-second recovery heartbeat. The local setting reduces this delay but does not promise exact alarm timing.

Private configuration is gitignored and created with mode `0600`. celld receives model credentials as ordinary deployment vars stored in the bucket: **this is not Cloudflare's managed secrets service**. Protect the files, Docker host, bucket credentials and backups. A single SeaweedFS instance is persistent local storage, not an HA cluster or an off-machine backup. Deleting its named volume deletes the authoritative data.

## Compatibility test

```sh
pnpm test:celld
```

This is an opt-in disruptive local test, not part of `pnpm check`: it temporarily changes the deployment on port 9876, kills/restarts this project's celld, and starts a fresh-cache node on port 9886. Do not run while using the local assistant. It uses a separate `companion-smoke` Worker identity, synthetic URLs, and deterministic HTTP/SSE model, OAuth and MCP fixtures; **no paid model or real Executor calls**. It restores the normal deployment and stops fixtures in `finally`. An externally killed test runner cannot guarantee cleanup; run `pnpm local:deploy` and stop the `fixtures` service if necessary.

The test exercises the actual `src/worker/index.ts`, `Session`, `Account`, Pi harness, SQLite adapter and MCP SDK—not a replacement counter demo:

- Authentication, signed socket tickets, cleaned-URL sharing and isolation.
- Selection context, streamed model turn, two simultaneous viewers, duplicate request IDs.
- OAuth discovery, dynamic registration, PKCE verification, callback, account-object token RPC.
- MCP discovery and a real SDK tool call with SSE results.
- Idle eviction with sockets still open, followed by constructor/transcript restoration.
- SIGKILL during an unfinished model request; a durable alarm resumes it without any browser/session request.
- A second node with a new empty cache restores the transcript and OAuth credentials from SeaweedFS alone.

The fixture service uses its own network namespace so restarting celld does not invalidate the fixture server. Only known transport failures are retried by bounded readiness checks. This is not an external-effect exactly-once test; mutating MCP calls deliberately remain non-replay-safe.

## Verification results

Verified locally with celld 0.6.2, SeaweedFS 4.48 and Linux x64:

| Check                                                                                     | Result                              |
| ----------------------------------------------------------------------------------------- | ----------------------------------- |
| All compatibility-test stages listed above, including SIGKILL and empty-cache restoration | Passed                              |
| SeaweedFS conditional create/update and stale-write rejection                             | Passed via `celld diagnose`         |
| Anti-slop lint and TypeScript                                                             | Passed                              |
| Unit tests + local Cloudflare workerd integration tests                                   | 40 passed                           |
| Extension build, Chromium smoke, Cloudflare deployment dry run                            | Passed                              |
| Real model provider, real Executor login, production Cloudflare deployment                | Not performed; credentials required |
| Multi-node partitions / production load                                                   | Not tested                          |

The initial default-cadence crash test exceeded its 150-second deadline; inspecting celld's waker lease established the longer takeover window described above. The final test uses a five-second scan setting and a bounded five-minute recovery deadline. Tests filter model requests by their fresh URL so leftovers from an earlier run cannot satisfy the recovery assertion.

## Not 1:1 Cloudflare parity

The same application source and DO declarations are used for both targets. However:

1. `scripts/local-prepare.mjs` removes Cloudflare-only `observability`, changes the callback origin, and supplies local secrets as vars. celld rejects unsupported top-level Wrangler keys.
2. `scripts/local.mjs` points `CELLD_ESBUILD` directly at the pinned executable. The pnpm-generated shim in this environment incorrectly invoked Node on esbuild's ELF binary.
3. celld is a beta runtime with partial Node compatibility. Passing this application's exercised paths is not proof that every Workers/Node API, future dependency update, or failure mode is portable.
4. A script rename changes celld object identities. Class rename/delete/transfer migrations and some RPC/stream semantics differ from Cloudflare.
5. Cloudflare and celld do **not** share their SQLite data or OAuth accounts. Switching extension backend origin selects a different backend store; migration/export is not implemented.
6. This setup is single-node. Network partitions, multi-node failover, production TLS, capacity/billing controls and long-duration load are not validated.

The Cloudflare side is checked with local **workerd** integration tests and `wrangler deploy --dry-run`; an actual Cloudflare production deployment and real model/Executor sign-in still require your credentials.

Sources: [celld compatibility matrix](https://celld.dev/docs/cloudflare-compat/), [Durable Objects semantics](https://celld.dev/docs/services/durable-objects/), [limitations](https://celld.dev/docs/limitations/), [0.6.2 release](https://github.com/denoland/celld/releases/tag/v0.6.2).
