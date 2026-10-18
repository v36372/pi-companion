const TRACKING = /^(utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid)$/i;

/** Versioned identity: do not broaden normalization without a migration. */
export function cleanUrl(input: string): string {
  if (input.length > 8192) throw new Error("URL is too long");
  const url = new URL(input);

  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Only HTTP(S) pages have sessions");

  if (url.username || url.password)
    throw new Error("URLs containing credentials are not supported");

  // Preserve query order, duplicates, and encoding; some applications/signatures depend on them.
  const parts = url.search
    .slice(1)
    .split("&")
    .filter((part) => {
      try {
        return !TRACKING.test(decodeURIComponent(part.split("=")[0].replace(/\+/g, " ")));
      } catch {
        return true;
      }
    });

  url.search = parts.filter(Boolean).join("&");
  // Keep hash routes and state fragments, but not document anchors/text-fragment highlights.
  url.hash = url.hash.split(":~:text=")[0];

  if (!/^#!?\//.test(url.hash) && !url.hash.includes("=")) url.hash = "";

  return url.href;
}

export async function sessionKey(url: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("personal:url-v1:" + cleanUrl(url)),
  );

  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}
