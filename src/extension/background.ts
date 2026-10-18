import { cleanUrl } from "../shared/url.ts";

const MENU = "ask-companion";

async function configureTab(tab: chrome.tabs.Tab) {
  if (tab.id === undefined) return;
  let enabled = false;

  try {
    cleanUrl(tab.url ?? "");
    enabled = !tab.incognito;
  } catch {
    /* Chrome/internal URLs are not supported. */
  }

  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    enabled,
    path: "sidepanel.html?tabId=" + tab.id,
  });
}

async function setup() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU,
    title: "Ask Companion about selection",
    contexts: ["selection"],
    documentUrlPatterns: ["http://*/*", "https://*/*"],
  });
  await Promise.all((await chrome.tabs.query({})).map(configureTab));
}

chrome.runtime.onInstalled.addListener(() => {
  void setup();
});

chrome.runtime.onStartup.addListener(() => {
  void setup();
});

chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (change.url || change.status === "complete") void configureTab(tab);
});

chrome.tabs.onCreated.addListener((tab) => {
  void configureTab(tab);
});

// Open synchronously in the gesture handler; awaiting unrelated work can lose Chrome's user activation.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void chrome.sidePanel.open({ tabId: tab.id });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "open-companion" && tab?.id !== undefined)
    void chrome.sidePanel.open({ tabId: tab.id });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU || !tab?.url || tab.incognito) return;
  const id = crypto.randomUUID();
  // The selection is captured with its source URL, not looked up later from whichever tab is active.
  void chrome.storage.session
    .set({
      ["selection:" + id]: {
        url: tab.url,
        title: (tab.title ?? "").slice(0, 1000),
        selection: (info.selectionText ?? "").slice(0, 24000),
      },
    })
    .then(() =>
      chrome.windows.create({
        url: chrome.runtime.getURL("ask.html?selection=" + id),
        type: "popup",
        width: 460,
        height: 640,
      }),
    );
});
