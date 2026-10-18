// Deterministic local-only OAuth, MCP and streaming model. Never used by the normal deployment.
import http from "node:http";
import { createHash } from "node:crypto";

const origin = "http://fixtures:9080";
const requests = [];
const toolCalls = [];
const codes = new Map();
let held = false;
let holdNext;

function json(response, body, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function stream(response, delta, finish) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });

  for (const [part, reason] of [
    [delta, null],
    [{}, finish],
  ]) {
    response.write(
      "data: " +
        JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta: part, finish_reason: reason }],
        }) +
        "\n\n",
    );
  }

  response.end("data: [DONE]\n\n");
}

http
  .createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);

      if (url.pathname === "/stats") return json(response, { requests, toolCalls, held });

      if (url.pathname === "/hold-next") {
        holdNext = url.searchParams.get("url");

        return json(response, { ok: true });
      }

      let body = "";

      for await (const chunk of request) {
        body += chunk;

        if (body.length > 1024 * 1024) throw new Error("Fixture input too large");
      }

      if (url.pathname.includes("oauth-protected-resource"))
        return json(response, {
          resource: origin + "/mcp",
          authorization_servers: [origin + "/auth"],
          scopes_supported: ["mcp", "offline_access"],
        });

      if (url.pathname.includes("oauth-authorization-server"))
        return json(response, {
          issuer: origin + "/auth",
          authorization_endpoint: origin + "/auth/authorize",
          token_endpoint: origin + "/auth/token",
          registration_endpoint: origin + "/auth/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        });

      if (url.pathname === "/auth/register")
        return json(response, { ...JSON.parse(body), client_id: "fixture-client" });

      if (url.pathname === "/auth/authorize") {
        const code = crypto.randomUUID();
        codes.set(code, url.searchParams.get("code_challenge"));
        const callback = new URL(url.searchParams.get("redirect_uri"));
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", url.searchParams.get("state"));
        callback.searchParams.set("iss", origin + "/auth");
        response.writeHead(302, { Location: callback.href });

        return response.end();
      }

      if (url.pathname === "/auth/token") {
        const params = new URLSearchParams(body);

        if (params.get("grant_type") === "authorization_code") {
          const challenge = createHash("sha256")
            .update(params.get("code_verifier") ?? "")
            .digest("base64url");

          if (codes.get(params.get("code")) !== challenge)
            return json(response, { error: "invalid_grant" }, 400);
          codes.delete(params.get("code"));
        }

        return json(response, {
          access_token: "fixture-access",
          refresh_token: "fixture-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      if (url.pathname === "/mcp") {
        if (request.headers.authorization !== "Bearer fixture-access")
          return json(response, { error: "unauthorized" }, 401);

        if (request.method !== "POST") return json(response, {}, 405);
        const message = JSON.parse(body);

        if (message.id === undefined) {
          response.writeHead(202);

          return response.end();
        }

        let result;

        if (message.method === "initialize")
          result = {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
            instructions: "This is a deterministic test fixture.",
          };
        else if (message.method === "tools/list")
          result = {
            tools: [
              {
                name: "fixture_echo",
                description: "Echo a test value",
                inputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
          };
        else if (message.method === "tools/call") {
          toolCalls.push(message.params);
          result = {
            content: [{ type: "text", text: "Fixture echoed: " + message.params.arguments.value }],
          };
        } else throw new Error("Unexpected MCP method");

        response.writeHead(200, { "Content-Type": "text/event-stream" });

        return response.end(
          "event: message\ndata: " +
            JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) +
            "\n\n",
        );
      }

      if (url.pathname === "/v1/chat/completions") {
        if (request.headers.authorization !== "Bearer fixture-key")
          return json(response, { error: "unauthorized" }, 401);
        const input = JSON.parse(body);
        requests.push(input);

        if (holdNext && JSON.stringify(input).includes(holdNext)) {
          holdNext = undefined;
          held = true;
          request.socket.once("close", () => {
            held = false;
          });

          return; // Keep this request pending until the test kills celld.
        }

        const last = input.messages.at(-1);
        let tool;

        if (last.role === "user" && last.content.includes("CALL_MCP_FIXTURE"))
          tool = { name: "mcp_list_tools", arguments: "{}" };
        else if (last.role === "tool" && last.content.includes('"tools":['))
          tool = {
            name: "mcp_call_tool",
            arguments: JSON.stringify({ name: "fixture_echo", arguments: { value: "hello" } }),
          };

        if (tool)
          return stream(
            response,
            {
              role: "assistant",
              tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function", function: tool }],
            },
            "tool_calls",
          );

        return stream(
          response,
          { role: "assistant", content: "Hello from the durable fixture agent." },
          "stop",
        );
      }

      return json(response, { error: "Not found" }, 404);
    } catch (error) {
      console.error(error.message);
      json(response, { error: error.message }, 500);
    }
  })
  .listen(9080, "0.0.0.0", () => console.log("Local fixtures listening on 9080"));
