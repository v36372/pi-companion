import { describe, it, expect } from "vitest";
import { cleanUrl, sessionKey } from "../src/shared/url.ts";

describe("URL identity", () => {
  it("cleans trackers, host casing, default ports, and text fragments", () => {
    expect(cleanUrl("https://EXAMPLE.COM:443/a?utm_source=x&id=2&fbclid=3#:~:text=hello")).toBe(
      "https://example.com/a?id=2",
    );
  });
  it("preserves semantic query parameters, order, duplicates, case, and slashes", () => {
    const urls = [
      "https://e.test/A?a=%20&a=+&b=2",
      "http://e.test/a/",
      "https://e.test/a?ref=document",
    ];

    for (const url of urls) expect(cleanUrl(url)).toBe(url);
    expect(cleanUrl("https://e.test/a")).not.toBe(cleanUrl("https://e.test/a/"));
  });
  it("preserves SPA routes/state but ignores plain document anchors", () => {
    expect(cleanUrl("https://e.test/#/inbox/2")).toBe("https://e.test/#/inbox/2");
    expect(cleanUrl("https://e.test/#!/inbox")).toBe("https://e.test/#!/inbox");
    expect(cleanUrl("https://e.test/#view=inbox")).toBe("https://e.test/#view=inbox");
    expect(cleanUrl("https://e.test/#heading")).toBe("https://e.test/");
  });
  it("is idempotent and maps equivalent URLs to the same session", async () => {
    const raw = "https://e.test/?a=1&utm_medium=email#heading";
    expect(cleanUrl(cleanUrl(raw))).toBe(cleanUrl(raw));
    expect(await sessionKey(raw)).toBe(await sessionKey("https://e.test/?a=1"));
    expect(await sessionKey(raw)).not.toBe(await sessionKey("https://e.test/?a=2"));
  });
  it.each([
    "chrome://settings",
    "file:///tmp/a",
    "javascript:alert(1)",
    "https://user:pass@e.test/",
    "garbage",
  ])("rejects unsupported identity %s", (url) => {
    expect(() => cleanUrl(url)).toThrow();
  });
});
