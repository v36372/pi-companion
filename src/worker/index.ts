import type { Env } from "./env.ts";
import { ResolveRequestSchema, type HttpResult } from "../shared/protocol.ts";
import { cleanUrl, sessionKey } from "../shared/url.ts";
import { authorized, ticket, verifyTicket } from "./security.ts";

export { Session } from "./session.ts";

export { Account } from "./account.ts";

const json = (value: HttpResult, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/oauth/callback" && request.method === "GET") {
        const code = url.searchParams.get("code"),
          state = url.searchParams.get("state");

        if (!code || !state)
          return new Response(
            "Authorization cancelled or invalid. Connect again from Companion settings.",
            { status: 400 },
          );

        const result = await env.ACCOUNT.getByName("personal").finishOAuth(
          code,
          state,
          url.searchParams.get("iss"),
        );

        if (!result.ok) return json({ error: result.error }, 400);

        return new Response("Executor connected. You can close this tab and return to Companion.", {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      }

      const socketMatch = /^\/api\/sessions\/([a-f0-9]{64})\/socket$/.exec(url.pathname);

      if (socketMatch && request.method === "GET") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
          return json({ error: "WebSocket required" }, 426);

        if (
          !(await verifyTicket(
            env.COMPANION_TOKEN,
            socketMatch[1],
            url.searchParams.get("ticket") ?? "",
          ))
        )
          return json({ error: "Unauthorized" }, 401);

        // The long-lived personal bearer token never appears in a WebSocket URL.
        return env.SESSIONS.getByName(socketMatch[1]).fetch(
          new Request("https://internal/socket", { headers: { Upgrade: "websocket" } }),
        );
      }

      if (!(await authorized(request, env.COMPANION_TOKEN)))
        return json({ error: "Unauthorized: check the personal token in settings" }, 401);
      const account = env.ACCOUNT.getByName("personal");

      if (url.pathname === "/api/status" && request.method === "GET")
        return json({
          ...(await account.status()),
          modelConfigured: !!(env.MODEL_API_KEY && env.MODEL_ID && env.MODEL_BASE_URL),
        });

      if (url.pathname === "/api/oauth/start" && request.method === "POST")
        return json(await account.startOAuth());

      if (url.pathname === "/api/oauth/disconnect" && request.method === "POST") {
        await account.disconnect();

        return json({ connected: false });
      }

      if (url.pathname === "/api/sessions" && request.method === "POST") {
        // Read with a hard bound even when Content-Length is absent or dishonest.
        const reader = request.body?.getReader();

        if (!reader) return json({ error: "Missing body" }, 400);
        const chunks: Uint8Array[] = [];
        let size = 0;

        for (;;) {
          const { done, value } = await reader.read();

          if (done) break;
          size += value.byteLength;

          if (size > 12000) {
            await reader.cancel();

            return json({ error: "Body too large" }, 413);
          }

          chunks.push(value);
        }

        const bytes = new Uint8Array(size);
        let offset = 0;

        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }

        const body = ResolveRequestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
        const canonicalUrl = cleanUrl(body.url);
        const id = await sessionKey(canonicalUrl);
        await env.SESSIONS.getByName(id).bindUrl(canonicalUrl);

        return json({ id, canonicalUrl, ticket: await ticket(env.COMPANION_TOKEN, id) });
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      // No secrets or OAuth codes in logs. Error text is returned only to the initiating client.
      return json({ error: error instanceof Error ? error.message : "Request failed" }, 400);
    }
  },
} satisfies ExportedHandler<Env>;
