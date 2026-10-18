import { z } from "zod";
import { ErrorSchema, type JsonValue, SelectionDraftSchema } from "../shared/protocol.ts";

const SettingsSchema = z.object({ backend: z.string(), token: z.string() });

export type Settings = z.infer<typeof SettingsSchema>;

export type SelectionDraft = z.infer<typeof SelectionDraftSchema>;

export async function settings(): Promise<Settings | undefined> {
  return SettingsSchema.optional().parse((await chrome.storage.local.get("settings")).settings);
}

export function backendOrigin(input: string): string {
  const url = new URL(input);

  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Enter only the Worker origin, without a path or credentials");

  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  )
    throw new Error("Use HTTPS (or localhost for development)");

  return url.origin;
}

export async function api<T>(
  config: Settings,
  path: string,
  schema: z.ZodType<T>,
  body?: JsonValue,
): Promise<T> {
  const init: RequestInit = {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30000),
    redirect: "error",
    cache: "no-store",
  };

  if (body !== undefined) init.body = JSON.stringify(body);

  const response = await fetch(config.backend + path, init);
  const result = await response.json();

  if (!response.ok) {
    const error = ErrorSchema.safeParse(result);

    throw new Error(error.success ? error.data.error : "Request failed (" + response.status + ")");
  }

  return schema.parse(result);
}
