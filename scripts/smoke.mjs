import { chromium } from "playwright-core";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

const extension = resolve("dist/extension");

const context = await chromium.launchPersistentContext("", {
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "--no-sandbox",
  ],
  viewport: { width: 420, height: 760 },
});

const errors = [];

context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));

try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const sessions = new Map();
  const empty = () => ({ messages: [], partial: "", busy: false, queued: 0, tools: [] });
  await context.route("https://page.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Test article</title><p>Selected quotation</p>",
    }),
  );
  await context.route("https://backend.test/api/**", async (route) => {
    const request = route.request();

    if (request.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "*",
        },
      });
    const url = request.postDataJSON().url;
    const key = createHash("sha256").update(url).digest("hex");

    if (!sessions.has(key)) sessions.set(key, empty());

    return route.fulfill({
      json: { id: key, canonicalUrl: url, ticket: "test-ticket" },
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
  await context.routeWebSocket("wss://backend.test/**", (socket) => {
    const key = new URL(socket.url()).pathname.split("/")[3];
    socket.send(JSON.stringify({ type: "snapshot", state: sessions.get(key) }));
    socket.onMessage((frame) => {
      const command = JSON.parse(String(frame));

      if (command.type !== "prompt") return;
      const state = sessions.get(key);
      state.messages.push({ id: command.requestId, role: "user", text: command.text });
      state.messages.push({
        id: command.requestId + "-answer",
        role: "assistant",
        text: "Test response.",
      });
      socket.send(JSON.stringify({ type: "ack", requestId: command.requestId }));
      socket.send(JSON.stringify({ type: "snapshot", state }));
    });
  });
  await worker.evaluate(() =>
    chrome.storage.local.set({
      settings: {
        backend: "https://backend.test",
        token: "smoke-test-token-with-32-or-more-characters",
      },
    }),
  );
  const source = await context.newPage();
  await source.goto("https://page.test/article?utm_source=mail");

  const tabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith("https://page.test/article"))
        .id,
  );

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html?tabId=${tabId}`);
  await panel.getByText("Connected", { exact: true }).waitFor();
  await panel.getByRole("textbox", { name: "Message" }).fill("Explain this article");
  await panel.getByRole("button", { name: "Send" }).click();
  await panel.getByText("Test response.", { exact: true }).waitFor();

  const panelOptions = await worker.evaluate(
    (id) => chrome.sidePanel.getOptions({ tabId: id }),
    tabId,
  );

  assert.equal(panelOptions.path, `sidepanel.html?tabId=${tabId}`);
  await source.goto("https://page.test/different");
  await panel.waitForFunction(
    () =>
      document.querySelector(".page")?.textContent === "https://page.test/different" &&
      !document.body.textContent.includes("Test response."),
  );
  await source.goto("https://page.test/article");
  await panel.getByText("Test response.", { exact: true }).waitFor();
  await worker.evaluate(() =>
    chrome.storage.session.set({
      "selection:smoke": {
        url: "https://page.test/article",
        title: "Article",
        selection: "Selected quotation",
      },
    }),
  );
  const ask = await context.newPage();
  await ask.goto(`chrome-extension://${id}/ask.html?selection=smoke`);
  await ask.locator(".selection").getByText("Selected quotation", { exact: false }).waitFor();
  await ask.getByText("Connected", { exact: true }).waitFor();
  assert.equal(await ask.getByText("Test response.", { exact: true }).count(), 1);
  await mkdir("dist/screenshots", { recursive: true });
  await panel.screenshot({ path: "dist/screenshots/sidepanel.png" });
  await ask.screenshot({ path: "dist/screenshots/selection.png" });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.getByRole("heading", { name: "Your browser, with continuity." }).waitFor();
  await options.screenshot({ path: "dist/screenshots/settings.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "Extension smoke passed: background setup, chat, URL navigation/resume, selection dialog, settings; no page errors.",
  );
} finally {
  await context.close();
}
