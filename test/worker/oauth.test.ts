import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthStartSchema } from "../../src/shared/protocol.ts";
import {
  OAuthClientMetadataSchema,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import worker from "../../src/worker/index.ts";

async function startLogin() {
  const response = await worker.fetch(
    new Request("https://companion.test/api/oauth/start", {
      method: "POST",
      headers: { Authorization: "Bearer test-personal-token-with-at-least-32-characters" },
    }),
    bindings,
  );

  expect(response.status).toBe(200);

  return OAuthStartSchema.parse(await response.json());
}

function callback(code: string, state: string, issuer: string | null) {
  const url = new URL("https://companion.test/oauth/callback");
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);

  if (issuer) url.searchParams.set("iss", issuer);

  return worker.fetch(new Request(url), bindings);
}

const bindings = env;

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

function oauthServer() {
  const tokenBodies: URLSearchParams[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.hostname !== "executor.test") throw new Error("Unexpected external request");

    if (url.pathname.includes("oauth-protected-resource"))
      return Response.json({
        resource: "https://executor.test/mcp",
        authorization_servers: ["https://executor.test/auth"],
        scopes_supported: ["mcp", "offline_access"],
      });

    if (url.pathname.includes("oauth-authorization-server"))
      return Response.json({
        issuer: "https://executor.test/auth",
        authorization_endpoint: "https://executor.test/auth/authorize",
        token_endpoint: "https://executor.test/auth/token",
        registration_endpoint: "https://executor.test/auth/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });

    if (url.pathname.endsWith("/register"))
      return Response.json({
        ...OAuthClientMetadataSchema.parse(await request.json()),
        client_id: "companion-client",
      });

    if (url.pathname.endsWith("/token")) {
      tokenBodies.push(new URLSearchParams(await request.text()));

      return Response.json({
        access_token: "access-" + tokenBodies.length,
        refresh_token: "refresh-" + tokenBodies.length,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }

    return new Response("not found", { status: 404 });
  });

  return { tokenBodies };
}

describe("durable Executor OAuth", () => {
  it("can hibernate after authorization discovery", async () => {
    oauthServer();
    await startLogin();
    await evictDurableObject(bindings.ACCOUNT.getByName("personal"));
  });
  it("persists PKCE, validates state and issuer, consumes callbacks, and refreshes after eviction", async () => {
    const { tokenBodies } = oauthServer();
    const account = bindings.ACCOUNT.getByName("personal");
    const start = await startLogin();
    const authorization = new URL(start.url!);
    const state = authorization.searchParams.get("state")!;
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://companion.test/oauth/callback",
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("scope")).toContain("offline_access");
    expect((await callback("code", "wrong-state", "https://executor.test/auth")).status).toBe(400);
    expect((await callback("code", state, "https://attacker.test")).status).toBe(400);
    expect((await callback("code", state, null)).status).toBe(400);
    expect(tokenBodies).toHaveLength(0);
    await evictDurableObject(account);
    expect((await callback("code", state, "https://executor.test/auth")).status).toBe(200);
    expect(await runInDurableObject(account, (instance) => instance.status())).toEqual({
      connected: true,
    });
    expect(await runInDurableObject(account, (instance) => instance.accessToken())).toBe(
      "access-1",
    );
    const verifier = tokenBodies[0].get("code_verifier")!;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));

    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(challenge).toBe(authorization.searchParams.get("code_challenge"));
    expect((await callback("code", state, "https://executor.test/auth")).status).toBe(400);
    expect(tokenBodies).toHaveLength(1);
    await runInDurableObject(account, async (_instance, ctx) => {
      const saved = await ctx.storage.get<{ value: OAuthTokens; expires: number }>("tokens");
      await ctx.storage.put("tokens", { ...saved, expires: 0 });
    });
    await evictDurableObject(account);
    expect(
      await runInDurableObject(account, (instance) =>
        Promise.all([instance.accessToken(), instance.accessToken()]),
      ),
    ).toEqual(["access-2", "access-2"]);
    expect(tokenBodies).toHaveLength(2);
    expect(tokenBodies[1].get("grant_type")).toBe("refresh_token");
    expect(tokenBodies[1].get("refresh_token")).toBe("refresh-1");
    await runInDurableObject(account, (instance) => instance.disconnect());
    expect(await runInDurableObject(account, (instance) => instance.status())).toEqual({
      connected: false,
    });
    await expect(runInDurableObject(account, (instance) => instance.accessToken())).rejects.toThrow(
      "Connect Executor",
    );
  });
  it("rejects an expired authorization attempt before token exchange", async () => {
    const { tokenBodies } = oauthServer();
    const account = bindings.ACCOUNT.getByName("personal");
    const start = await startLogin();
    const state = new URL(start.url!).searchParams.get("state")!;
    await runInDurableObject(account, async (_instance, ctx) => {
      await ctx.storage.put("pending", { state, expires: 0 });
    });
    expect((await callback("code", state, "https://executor.test/auth")).status).toBe(400);
    expect(tokenBodies).toHaveLength(0);
  });
});
