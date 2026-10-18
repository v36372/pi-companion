import { describe, it, expect } from "vitest";
import { authorized, ticket, verifyTicket } from "../src/worker/security.ts";

const secret = "some-personal-token-with-32-or-more-characters";

describe("Worker authentication", () => {
  it("requires a configured strong personal token", async () => {
    expect(await authorized(new Request("https://test"), "")).toBe(false);
    expect(
      await authorized(
        new Request("https://test", { headers: { Authorization: "Bearer " + secret } }),
        secret,
      ),
    ).toBe(true);
    expect(
      await authorized(
        new Request("https://test", { headers: { Authorization: "Bearer wrong" } }),
        secret,
      ),
    ).toBe(false);
  });
  it("binds short-lived socket tickets to a session and rejects tampering, expiry, or rotation", async () => {
    const value = await ticket(secret, "session-a", 1000);
    expect(await verifyTicket(secret, "session-a", value, 1001)).toBe(true);
    expect(await verifyTicket(secret, "session-b", value, 1001)).toBe(false);
    expect(await verifyTicket(secret, "session-a", value, 61000)).toBe(false);
    expect(await verifyTicket(secret, "session-a", value + "f", 1001)).toBe(false);
    expect(await verifyTicket("other-secret", "session-a", value, 1001)).toBe(false);
    expect(value).not.toContain(secret);
  });
});
