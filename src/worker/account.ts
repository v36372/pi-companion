import { DurableObject } from "cloudflare:workers";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthTokens,
  OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Env } from "./env.ts";

type Pending = { state: string; expires: number };

type SavedTokens = { value: OAuthTokens; expires: number };

/** One personal credential owner. Never return credentials through the public Worker API. */
export class Account extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const config = JSON.stringify([this.env.MCP_URL, this.env.PUBLIC_ORIGIN]);

      if ((await this.ctx.storage.get("config")) !== config) {
        // Credentials must never follow a changed MCP server or callback configuration.
        await this.ctx.storage.delete(["tokens", "client", "pending", "verifier", "discovery"]);
        await this.ctx.storage.put("config", config);
      }

      return fn();
    };

    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined); // Keep later operations usable after a failed refresh.

    return result;
  }

  private provider(redirect?: (url: URL) => void): OAuthClientProvider {
    const storage = this.ctx.storage;
    const redirectUrl = new URL("/oauth/callback", this.env.PUBLIC_ORIGIN).href;

    return {
      redirectUrl,
      clientMetadata: {
        client_name: "Companion",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "mcp offline_access",
      },
      state: async () => {
        const pending = await storage.get<Pending>("pending");

        if (!pending) throw new Error("Start Connect Executor from settings");

        return pending.state;
      },
      clientInformation: () => storage.get<OAuthClientInformationMixed>("client"),
      saveClientInformation: (value) => storage.put("client", value),
      tokens: async () => (await storage.get<SavedTokens>("tokens"))?.value,
      saveTokens: async (value) => {
        const previous = await storage.get<SavedTokens>("tokens");
        await storage.put("tokens", {
          value: { ...value, refresh_token: value.refresh_token ?? previous?.value.refresh_token },
          expires:
            value.expires_in === undefined
              ? Number.MAX_SAFE_INTEGER
              : Date.now() + value.expires_in * 1000,
        } satisfies SavedTokens);
      },
      redirectToAuthorization: (url) => {
        if (!redirect)
          throw new Error("Executor needs login. Open Companion settings → Connect Executor.");
        redirect(url);
      },
      saveCodeVerifier: (value) => storage.put("verifier", value),
      codeVerifier: async () => {
        const value = await storage.get<string>("verifier");

        if (!value) throw new Error("OAuth attempt expired; connect again");

        return value;
      },
      discoveryState: () => storage.get<OAuthDiscoveryState>("discovery"),
      saveDiscoveryState: (value) => storage.put("discovery", value),
      invalidateCredentials: async (scope) => {
        const keys =
          scope === "all"
            ? ["tokens", "client", "verifier", "discovery"]
            : [scope === "client" ? "client" : scope];

        await storage.delete(keys);
      },
    };
  }

  startOAuth(): Promise<{ url?: string; connected: boolean }> {
    return this.serial(async () => {
      await this.ctx.storage.put("pending", {
        state: crypto.randomUUID(),
        expires: Date.now() + 600000,
      } satisfies Pending);
      let url: string | undefined;

      const result = await auth(
        this.provider((value) => {
          url = value.href;
        }),
        {
          serverUrl: this.env.MCP_URL,
          scope: "mcp offline_access",
          fetchFn: timedFetch,
        },
      );

      if (result === "AUTHORIZED") await this.ctx.storage.delete(["pending", "verifier"]);

      return { url, connected: result === "AUTHORIZED" };
    });
  }

  finishOAuth(
    code: string,
    state: string,
    issuer: string | null,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.serial(async () => {
      const pending = await this.ctx.storage.get<Pending>("pending");

      if (!pending || pending.state !== state || pending.expires <= Date.now())
        throw new Error("Invalid or expired OAuth state");
      const discovery = await this.ctx.storage.get<OAuthDiscoveryState>("discovery");
      const expected = discovery?.authorizationServerUrl;
      const metadata = discovery?.authorizationServerMetadata;

      const requiresIssuer =
        metadata &&
        "authorization_response_iss_parameter_supported" in metadata &&
        metadata.authorization_response_iss_parameter_supported;

      if ((issuer && issuer !== String(expected)) || (requiresIssuer && !issuer)) {
        throw new Error("Invalid OAuth issuer");
      }

      // Consume state before exchanging the code: callbacks cannot be replayed, including after a failed exchange.
      await this.ctx.storage.delete("pending");

      try {
        const result = await auth(this.provider(), {
          serverUrl: this.env.MCP_URL,
          authorizationCode: code,
          fetchFn: timedFetch,
        });

        if (result !== "AUTHORIZED") throw new Error("OAuth did not complete");
      } finally {
        await this.ctx.storage.delete("verifier");
      }
    }).then(
      () => ({ ok: true as const }),
      (error) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : "OAuth failed",
      }),
    );
  }

  accessToken(forceRefresh = false): Promise<string> {
    return this.serial(async () => {
      let saved = await this.ctx.storage.get<SavedTokens>("tokens");

      if (!saved) throw new Error("Connect Executor in Companion settings first");

      if (forceRefresh || saved.expires < Date.now() + 60000) {
        const result = await auth(this.provider(), {
          serverUrl: this.env.MCP_URL,
          fetchFn: timedFetch,
        });

        if (result !== "AUTHORIZED") throw new Error("Reconnect Executor in settings");
        saved = await this.ctx.storage.get<SavedTokens>("tokens");
      }

      if (!saved) throw new Error("Reconnect Executor in settings");

      return saved.value.access_token;
    });
  }

  status(): Promise<{ connected: boolean }> {
    return this.serial(async () => ({ connected: !!(await this.ctx.storage.get("tokens")) }));
  }

  disconnect(): Promise<void> {
    // Local unlink: server-side grants can also be revoked in Executor's account settings.
    return this.serial(async () => {
      await this.ctx.storage.delete(["tokens", "pending", "verifier"]);
    });
  }
}

export const timedFetch: typeof fetch = async (input, init) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("OAuth request timed out")), 20000);

  try {
    const response = await fetch(input, {
      ...init,
      signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), controller.signal]),
    });

    // OAuth responses are JSON, not streams. Consume under the timeout and release its timer afterwards.
    const reader = response.body?.getReader();

    if (!reader) return response;
    const chunks: Uint8Array[] = [];
    let length = 0;

    for (;;) {
      const { value, done } = await reader.read();

      if (done) break;
      length += value.length;

      if (length > 1024 * 1024) {
        await reader.cancel();
        throw new Error("OAuth response too large");
      }

      chunks.push(value);
    }

    const body = new Uint8Array(length);
    let offset = 0;

    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timeout);
  }
};
