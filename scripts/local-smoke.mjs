// Requires a --test deployment and the fixtures profile. Restarts only this project's celld.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { EventSchema, SessionResponseSchema, OAuthStartSchema } from "../src/shared/protocol.ts";

const { COMPANION_TOKEN } = JSON.parse(await readFile(".local/config/worker-vars.json", "utf8"));
const base = "http://localhost:9876";
const sockets = [];

const compose = (...args) =>
  execFileSync("docker", ["compose", "-f", "compose.local.yaml", "--profile", "test", ...args], {
    stdio: "inherit",
  });

async function api(path, body, origin = base) {
  const init = {
    headers: { Authorization: "Bearer " + COMPANION_TOKEN },
    signal: AbortSignal.timeout(20000),
  };

  if (body !== undefined) {
    init.method = "POST";
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }

  const response = await fetch(origin + path, init);
  assert.equal(response.status, 200, path + ": " + (response.ok ? "" : await response.text()));

  return response.json();
}

async function wait(label, predicate, timeout = 90000) {
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    try {
      if (await predicate()) return;
    } catch (error) {
      // A Docker restart can invalidate pooled connections; only retry known transport failures.
      if (
        !["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET", "ETIMEDOUT"].includes(error.cause?.code)
      )
        throw error;
    }

    await delay(250);
  }

  throw new Error("Timeout: " + label);
}

async function stats(url) {
  const result = await (
    await fetch("http://localhost:9080/stats", { signal: AbortSignal.timeout(5000) })
  ).json();

  if (url)
    result.requests = result.requests.filter((request) => JSON.stringify(request).includes(url));

  return result;
}

const resolve = async (url, origin) =>
  SessionResponseSchema.parse(await api("/api/sessions", { url }, origin));

async function connect(session, origin = base) {
  const endpoint = new URL(origin + "/api/sessions/" + session.id + "/socket");
  endpoint.protocol = "ws:";
  endpoint.searchParams.set("ticket", session.ticket);
  const socket = new WebSocket(endpoint);
  sockets.push(socket);
  const events = [];
  const changes = new Set();
  socket.addEventListener("message", (message) => {
    events.push(EventSchema.parse(JSON.parse(message.data)));

    for (const notify of changes) notify();
  });

  const next = (predicate) =>
    new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        changes.delete(check);
      };

      const check = () => {
        const event = events.find(predicate);

        if (event) {
          cleanup();
          resolve(event);
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("WebSocket event timeout: " + JSON.stringify(events.at(-1))));
      }, 30000);

      changes.add(check);
      check();
    });

  await next((event) => event.type === "snapshot");

  return {
    socket,
    events,
    next,
    snapshot: (predicate) => next((event) => event.type === "snapshot" && predicate(event.state)),
  };
}

const completed = (count) => (state) =>
  !state.busy && state.messages.filter((message) => message.role === "assistant").length >= count;

const prompt = (text) => ({
  type: "prompt",
  requestId: crypto.randomUUID(),
  text,
  title: "Celld compatibility",
  selection: "Selected quotation",
});

try {
  await wait("test deployment readiness", async () => (await api("/api/status")).modelConfigured);
  await wait("fixture readiness", async () => Array.isArray((await stats()).requests));
  assert.equal((await fetch(base + "/api/status")).status, 401);
  assert.equal((await api("/api/status")).modelConfigured, true);
  const url = "https://example.com/celld-smoke/" + crypto.randomUUID();
  const first = await resolve(url + "?utm_source=smoke");
  assert.equal(first.id, (await resolve(url)).id);
  assert.notEqual(first.id, (await resolve(url + "/other")).id);
  console.log("PASS authentication and cleaned URL isolation");

  const a = await connect(first);
  const b = await connect(await resolve(url));
  const message = prompt("Explain this selection");
  const before = (await stats(url)).requests.length;
  a.socket.send(JSON.stringify(message));
  const done = await b.snapshot(completed(1));
  assert.equal(done.state.messages.filter((entry) => entry.role === "user").length, 1);
  assert.match(
    done.state.messages.find((entry) => entry.role === "assistant").text,
    /durable fixture agent/,
  );
  await a.next((event) => event.type === "ack" && event.requestId === message.requestId);
  a.socket.send(JSON.stringify(message));
  await wait(
    "duplicate receipt",
    () =>
      a.events.filter((event) => event.type === "ack" && event.requestId === message.requestId)
        .length === 2,
  );
  const model = await stats(url);
  assert.equal(model.requests.length, before + 1);
  assert.match(JSON.stringify(model.requests.at(-1)), /Selected quotation/);
  console.log("PASS real Pi agent streaming, two-tab broadcast, selection, durable deduplication");

  await api("/api/oauth/disconnect", {});
  const login = OAuthStartSchema.parse(await api("/api/oauth/start", {}));
  const authorization = new URL(login.url);
  authorization.hostname = "localhost"; // Docker's fixtures DNS name is not a host-machine name.
  const callback = await fetch(authorization, { signal: AbortSignal.timeout(20000) });
  assert.equal(callback.status, 200, await callback.text());
  assert.equal((await api("/api/status")).connected, true);
  a.socket.send(JSON.stringify(prompt("CALL_MCP_FIXTURE")));
  const tools = await b.snapshot(completed(2));
  assert.ok(
    tools.state.messages.some(
      (entry) => entry.role === "tool" && entry.text.includes("Fixture echoed"),
    ),
  );
  assert.equal((await stats()).toolCalls.at(-1).name, "fixture_echo");
  console.log(
    "PASS actual OAuth PKCE exchange, credential DO RPC, MCP discovery and SSE tool call",
  );

  await wait("socket-preserving hibernation", async () => {
    const state = await (await fetch("http://localhost:9877/state")).json();

    return state.node_load.resident_cells === 0 && state.node_load.host_websockets === 2;
  });
  assert.equal(a.socket.readyState, WebSocket.OPEN);
  a.socket.send(JSON.stringify(prompt("Wake after hibernation")));
  await b.snapshot(completed(3));
  console.log("PASS hibernation with live sockets and constructor restoration");
  a.socket.close();
  b.socket.close();

  const recovering = await connect(await resolve(url + "/recovery"));
  const recoveryCount = (await stats(url + "/recovery")).requests.length;
  await fetch("http://localhost:9080/hold-next?url=" + encodeURIComponent(url + "/recovery"));
  const recoveryMessage = prompt("Continue without a browser after a crash");
  recovering.socket.send(JSON.stringify(recoveryMessage));
  await recovering.next(
    (event) => event.type === "ack" && event.requestId === recoveryMessage.requestId,
  );
  await wait("held model request", async () => (await stats()).held);
  recovering.socket.close();
  compose("kill", "-s", "SIGKILL", "celld");
  compose("start", "celld");
  // No request to the Worker or Session until a second model call proves alarm-driven recovery.
  await wait(
    "alarm resumes work without a viewer",
    async () => (await stats(url + "/recovery")).requests.length >= recoveryCount + 2,
    300000,
  );
  const restored = await connect(await resolve(url + "/recovery"));
  const result = await restored.snapshot(completed(1));
  assert.equal(result.state.messages.filter((entry) => entry.role === "user").length, 1);
  restored.socket.send(JSON.stringify(recoveryMessage));
  await restored.next(
    (event) => event.type === "ack" && event.requestId === recoveryMessage.requestId,
  );
  assert.equal((await stats(url + "/recovery")).requests.length, recoveryCount + 2);
  restored.socket.close();
  assert.equal((await api("/api/status")).connected, true);
  console.log(
    "PASS SIGKILL recovery via durable alarm without a browser; receipt and OAuth credentials survive",
  );

  const coldName = "companion-cold-" + crypto.randomUUID().slice(0, 8);
  const coldCache = coldName + "-cache";
  const coldOrigin = "http://localhost:9886";
  compose("stop", "celld");

  try {
    compose(
      "run",
      "-d",
      "--no-deps",
      "--name",
      coldName,
      "-p",
      "127.0.0.1:9886:8080",
      "-v",
      coldCache + ":/var/lib/celld",
      "-e",
      "CELLD_ADVERTISE=" + coldName + ":8081",
      "celld",
    );
    await wait(
      "empty-cache node readiness",
      async () => (await fetch(coldOrigin + "/.well-known/celld/health")).ok,
    );
    const cold = await connect(await resolve(url, coldOrigin), coldOrigin);
    const transcript = await cold.snapshot(completed(3));
    assert.equal(transcript.state.messages.filter((entry) => entry.role === "user").length, 3);
    assert.equal((await api("/api/status", undefined, coldOrigin)).connected, true);
    cold.socket.close();
    console.log(
      "PASS fresh celld node restores transcript and OAuth credentials from SeaweedFS alone",
    );
  } finally {
    execFileSync("docker", ["rm", "-f", coldName], { stdio: "inherit" });
    execFileSync("docker", ["volume", "rm", coldCache], { stdio: "inherit" });
    compose("start", "celld");
  }

  console.log("CELLD_SMOKE_OK");
} finally {
  for (const socket of sockets) socket.close();
}
