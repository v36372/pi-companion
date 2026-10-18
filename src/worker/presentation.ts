import type {
  ConversationView,
  EntryRecord,
  LiveState,
  InboxState,
} from "@earendil-works/pi-durable";
import { PromptDataSchema, type Message, type Snapshot } from "../shared/protocol.ts";

type ModelContent = NonNullable<EntryRecord["model"]>[number]["content"];

function textOf(value: ModelContent): string {
  if (!Array.isArray(value)) return value;

  return value.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

export function present(view: ConversationView): Snapshot {
  const messages: Message[] = [];
  let budget = 80000;

  for (const entry of [...view.entries].reverse()) {
    if (messages.length >= 60 || budget <= 0) break;

    const model = entry.model?.[0];

    if (
      !model ||
      (model.role !== "user" && model.role !== "assistant" && model.role !== "toolResult")
    )
      continue;

    let text = textOf(model.content);

    if (entry.kind === "companion.prompt") {
      const data = PromptDataSchema.parse(entry.data);
      text = data.selection ? "“" + data.selection + "”\n\n" + data.text : data.text;
    }

    if (model.role === "assistant" && !text) text = model.errorMessage ?? "";

    if (!text) continue;

    const limit = Math.min(budget, 16000);

    if (text.length > limit) text = text.slice(0, limit) + "\n[Display truncated]";
    budget -= text.length;
    messages.push({
      id: String(entry.id),
      role: model.role === "toolResult" ? "tool" : model.role,
      text,
      error:
        (model.role === "toolResult" && !!model.isError) ||
        (model.role === "assistant" && model.stopReason === "error"),
    });
  }

  // SAFETY: Pi Durable owns these built-in document kinds; its hydrated view retains their registered schemas.
  const live = view.docs["pi.live"] as LiveState | undefined;
  // SAFETY: pi.inbox is written and hydrated by Pi's InboxDoc definition, not by the browser protocol.
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;

  return {
    messages: messages.reverse(),
    partial: textOf(live?.generation?.message?.content ?? []).slice(-24000),
    busy: !!live?.run,
    queued: inbox?.items.length ?? 0,
    tools: (live?.tools ?? []).map((tool) => tool.name),
  };
}
