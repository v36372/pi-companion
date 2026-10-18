const bytes = (s: string) => new TextEncoder().encode(s);

const hex = (a: ArrayBuffer) =>
  Array.from(new Uint8Array(a), (n) => n.toString(16).padStart(2, "0")).join("");

async function key(secret: string) {
  return crypto.subtle.importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function authorized(request: Request, secret: string): Promise<boolean> {
  if (!secret || secret.length < 32) return false;
  const actual = request.headers.get("Authorization") ?? "";
  const signature = await crypto.subtle.sign("HMAC", await key(secret), bytes("Bearer " + secret));

  return crypto.subtle.verify("HMAC", await key(secret), signature, bytes(actual));
}

export async function ticket(secret: string, id: string, now = Date.now()): Promise<string> {
  const value = id + "." + (now + 60000) + "." + crypto.randomUUID();

  return value + "." + hex(await crypto.subtle.sign("HMAC", await key(secret), bytes(value)));
}

export async function verifyTicket(
  secret: string,
  id: string,
  value: string,
  now = Date.now(),
): Promise<boolean> {
  const parts = value.split(".");

  if (
    !secret ||
    secret.length < 32 ||
    parts.length !== 4 ||
    parts[0] !== id ||
    !/^\d+$/.test(parts[1]) ||
    !/^[a-f0-9]{64}$/.test(parts[3])
  )
    return false;
  const expiry = Number(parts[1]);

  if (expiry <= now || expiry > now + 60000) return false;
  const signature = Uint8Array.from(parts[3].match(/../g)!, (s) => parseInt(s, 16));

  return crypto.subtle.verify(
    "HMAC",
    await key(secret),
    signature,
    bytes(parts.slice(0, 3).join(".")),
  );
}
