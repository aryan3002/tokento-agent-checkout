// The shopping agent's turn: stream Claude, run its tool calls against Tokento,
// feed the results back, repeat until it answers (at most 8 tool rounds).
//
// The conversation is append-only: every assistant message goes back exactly as
// Claude sent it, thinking blocks included, and the system prompt and tool list
// never change, so the prompt cache and Claude's earlier reasoning stay valid.
import Anthropic from "@anthropic-ai/sdk";
import type { TokentoClient } from "../tokento";
import type { UiEvent } from "./events";
import { SYSTEM_PROMPT } from "./prompt";
import { AGENT_TOOLS, runTool } from "./tools";

export type { UiEvent } from "./events";

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaStreamEvent = Anthropic.Beta.BetaRawMessageStreamEvent;
type BetaToolUseBlock = Anthropic.Beta.BetaToolUseBlock;

export interface StreamLike extends AsyncIterable<BetaStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
}

type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

/** The part of the Anthropic client the agent uses (a real `new Anthropic()` fits). */
export interface ClaudeLike {
  beta: { messages: { stream(params: StreamParams): StreamLike } };
}

export const AGENT_MODEL = "claude-opus-5-5";
const MAX_TOOL_ROUNDS = 8;
const MAX_JSON_RETRIES = 2;

function requestParams(messages: BetaMessageParam[]): StreamParams {
  return {
    model: AGENT_MODEL,
    max_tokens: 32000,
    // Refusal fallbacks re-run a declined request on another model server-side;
    // "updates" returns Claude's short progress notes between tool calls.
    betas: ["server-side-fallback-2026-07-01", "thinking-display-updates-2026-08-18"],
    fallbacks: "default" as const,
    thinking: { type: "adaptive" as const, display: "updates" as const },
    output_config: { effort: "medium" as const },
    cache_control: { type: "ephemeral" as const },
    system: SYSTEM_PROMPT,
    tools: AGENT_TOOLS,
    messages,
  };
}

export async function* runAgentTurn(
  deps: { claude: ClaudeLike; api: TokentoClient },
  history: BetaMessageParam[],
  userText: string,
  opts: { maxToolRounds?: number } = {},
): AsyncGenerator<UiEvent> {
  const maxRounds = opts.maxToolRounds ?? MAX_TOOL_ROUNDS;
  const messages: BetaMessageParam[] = [...history, { role: "user", content: userText }];
  let rounds = 0;
  let jsonRetries = 0;
  let stopReason = "end_turn";

  while (true) {
    let message: BetaMessage;
    try {
      const stream = deps.claude.beta.messages.stream(requestParams(messages));
      const thinking = new Map<number, string>();
      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          yield { type: "tool_start", id: event.content_block.id, name: event.content_block.name };
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield { type: "text", delta: event.delta.text };
          } else if (event.delta.type === "thinking_delta") {
            thinking.set(event.index, (thinking.get(event.index) ?? "") + event.delta.thinking);
          }
        } else if (event.type === "content_block_stop") {
          const note = thinking.get(event.index)?.trim();
          if (note) yield { type: "progress", text: note };
          thinking.delete(event.index);
        }
      }
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      if (err instanceof Anthropic.APIError || jsonRetries >= MAX_JSON_RETRIES) {
        yield { type: "error", message: "The shopping assistant is unavailable right now. Please try again." };
        stopReason = "error";
        break;
      }
      // A tool input that could not be parsed at all (eager input streaming): re-issue the turn.
      jsonRetries += 1;
      continue;
    }

    const toolUses = message.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");

    if (message.stop_reason === "refusal") {
      // A refusal can cut a tool call off mid-input: never run it, and don't keep the partial reply.
      yield { type: "notice", text: "I can't help with that one. Try asking a different way." };
      stopReason = "refusal";
      break;
    }
    if (message.stop_reason === "max_tokens" && toolUses.length > 0) {
      yield { type: "notice", text: "That got too long for me to finish. Try a simpler request." };
      stopReason = "max_tokens";
      break;
    }

    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "pause_turn") continue;
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
      stopReason = message.stop_reason ?? "end_turn";
      break;
    }

    rounds += 1;
    const outcomes = await Promise.all(toolUses.map((block) => runTool(block.name, block.input, { api: deps.api, toolUseId: block.id })));
    for (const [i, block] of toolUses.entries()) {
      yield { type: "tool_result", id: block.id, name: block.name, ok: !outcomes[i].isError };
      const ui = outcomes[i].ui;
      if (ui) yield ui;
    }
    messages.push({
      role: "user",
      content: toolUses.map((block, i) => ({
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: outcomes[i].content,
        ...(outcomes[i].isError ? { is_error: true } : {}),
      })),
    });

    if (rounds >= maxRounds) {
      yield { type: "notice", text: `I stopped after ${maxRounds} steps. Tell me how you'd like to continue.` };
      stopReason = "max_tool_rounds";
      break;
    }
  }

  yield { type: "history", messages };
  yield { type: "done", stopReason };
}
