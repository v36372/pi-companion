import type { Session } from "./session.ts";
import type { Account } from "./account.ts";

export interface Env {
  SESSIONS: DurableObjectNamespace<Session>;
  ACCOUNT: DurableObjectNamespace<Account>;
  COMPANION_TOKEN: string;
  PUBLIC_ORIGIN: string;
  MCP_URL: string;
  MODEL_BASE_URL: string;
  MODEL_ID: string;
  MODEL_API_KEY: string;
  MODEL_CONTEXT_WINDOW: string;
  MODEL_MAX_TOKENS: string;
}

type WorkerBindings = Env;

declare global {
  namespace Cloudflare {
    interface Env extends WorkerBindings {}
  }
}
