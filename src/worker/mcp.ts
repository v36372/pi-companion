import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Env } from "./env.ts";

/** A bounded connection per operation; no idle MCP SSE connection prevents DO hibernation. */
export async function withMcp<T>(
  env: Env,
  signal: AbortSignal,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const account = env.ACCOUNT.getByName("personal");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("MCP request timed out")), 90000);
  let token: string;

  try {
    token = await account.accessToken();
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }

  const client = new Client(
    { name: "companion", version: "0.1.0" },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );

  const transport = new StreamableHTTPClientTransport(new URL(env.MCP_URL), {
    requestInit: { headers: { Authorization: "Bearer " + token } },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", "Bearer " + token);

      return fetch(input, {
        ...init,
        headers,
        signal: AbortSignal.any([
          signal,
          controller.signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
    },
  });

  try {
    try {
      await client.connect(transport, { timeout: 20000 });
    } catch (error) {
      // Do not replay tools/call after errors. A failed handshake can be retried by the caller.
      if (error instanceof Error && /401|unauthorized/i.test(error.message)) {
        token = await account.accessToken(true);
        throw new Error("Executor authorization refreshed. Retry the MCP request.");
      }

      throw error;
    }

    return await fn(client);
  } finally {
    // Always release the optional SSE stream; close does not replay/terminate remote work.
    clearTimeout(timeout);
    await client.close();
  }
}

export async function listMcp(env: Env, signal: AbortSignal, cursor?: string) {
  return withMcp(env, signal, async (client) => ({
    instructions: client.getInstructions(),
    ...(await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 30000 })),
  }));
}

export async function callMcp(
  env: Env,
  signal: AbortSignal,
  name: string,
  args: NonNullable<Parameters<Client["callTool"]>[0]["arguments"]>,
) {
  return withMcp(env, signal, (client) =>
    client.callTool({ name, arguments: args }, undefined, {
      signal,
      timeout: 90000,
      maxTotalTimeout: 90000,
    }),
  );
}
