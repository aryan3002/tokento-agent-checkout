// The shopping agent's turn on Azure OpenAI (Responses API): stream the model,
// run its function calls against Tokento, feed the results back, repeat until
// it answers (at most 8 tool rounds).
//
// Nothing is stored on Azure's side (store: false). The browser keeps the
// conversation and every output item goes back exactly as the model sent it,
// reasoning included (encrypted), so the model keeps its earlier reasoning
// across tool calls and turns.
import type OpenAI from "openai";
import type { TokentoClient } from "../tokento";
import type { AgentHistory, UiEvent } from "./events";
import { SYSTEM_PROMPT } from "./prompt";
import { AGENT_TOOLS, runTool } from "./tools";
import type { ModelUsage } from "./usage-guard";

export type { AgentHistory, UiEvent } from "./events";

type StreamParams = OpenAI.Responses.ResponseCreateParamsStreaming;
type StreamEvent = OpenAI.Responses.ResponseStreamEvent;
type ModelResponse = OpenAI.Responses.Response;
type FunctionCall = OpenAI.Responses.ResponseFunctionToolCall;

/** The part of the OpenAI client the agent uses (a real `new OpenAI()` fits). */
export interface ModelClient {
  responses: { create(params: StreamParams): PromiseLike<AsyncIterable<StreamEvent>> };
}

export interface AgentModelConfig {
  /** The Azure deployment name (the `model` in each request). */
  deployment: string;
  /** null for deployments whose model doesn't reason (e.g. gpt-4.1). */
  reasoningEffort: "minimal" | "low" | "medium" | "high" | null;
}

const MAX_TOOL_ROUNDS = 8;
const UNAVAILABLE = "The shopping assistant is unavailable right now. Please try again.";

function requestParams(input: AgentHistory, config: AgentModelConfig): StreamParams {
  return {
    model: config.deployment,
    instructions: SYSTEM_PROMPT,
    input,
    tools: AGENT_TOOLS,
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    // Reasoning plus a short reply fit easily; a cap keeps one call from running up the bill.
    max_output_tokens: 6000,
    // Reasoning summaries become the short progress lines in the chat.
    ...(config.reasoningEffort
      ? { reasoning: { effort: config.reasoningEffort, summary: "auto" as const }, include: ["reasoning.encrypted_content" as const] }
      : {}),
  };
}

/** A reasoning summary opens with a bold title; that title alone is the chat's progress line. */
function progressNote(summary: string): string {
  const text = summary.trim();
  const title = /^\*\*(.+?)\*\*/.exec(text)?.[1]?.trim();
  if (title) return title;
  const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return first.length > 140 ? `${first.slice(0, 139)}…` : first;
}

/** The model's arguments are a JSON string; broken JSON reaches the tool's validation and fails there. */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function* runAgentTurn(
  deps: {
    model: ModelClient;
    config: AgentModelConfig;
    api: TokentoClient;
    /** Charges each model call; `stop` ends the request before any more tool rounds. May check a shared budget (async). */
    meter?: (usage: ModelUsage) => { stop: boolean } | Promise<{ stop: boolean }>;
  },
  history: AgentHistory,
  userText: string,
  opts: { maxToolRounds?: number } = {},
): AsyncGenerator<UiEvent> {
  const maxRounds = opts.maxToolRounds ?? MAX_TOOL_ROUNDS;
  const input: AgentHistory = [...history, { role: "user", content: userText }];
  let rounds = 0;
  let stopReason = "end_turn";

  while (true) {
    let response: ModelResponse | null = null;
    let refused = false;
    try {
      const stream = await deps.model.responses.create(requestParams(input, deps.config));
      for await (const event of stream) {
        switch (event.type) {
          case "response.output_item.added":
            if (event.item.type === "function_call") yield { type: "tool_start", id: event.item.call_id, name: event.item.name };
            break;
          case "response.output_text.delta":
            yield { type: "text", delta: event.delta };
            break;
          case "response.reasoning_summary_text.done": {
            const note = progressNote(event.text);
            if (note) yield { type: "progress", text: note };
            break;
          }
          case "response.refusal.delta":
            refused = true;
            break;
          case "response.completed":
          case "response.incomplete":
          case "response.failed":
            response = event.response;
            break;
        }
      }
    } catch {
      response = null;
    }

    if (!response || response.status === "failed") {
      yield { type: "error", message: UNAVAILABLE };
      stopReason = "error";
      break;
    }

    const calls = response.output.filter((item): item is FunctionCall => item.type === "function_call");
    const overBudget = response.usage && deps.meter ? (await deps.meter(response.usage)).stop : false;

    if (refused) {
      // Never run a tool from a reply the model refused, and don't keep that reply.
      yield { type: "notice", text: "I can't help with that one. Try asking a different way." };
      stopReason = "refusal";
      break;
    }
    if (response.status === "incomplete" && calls.length > 0) {
      yield { type: "notice", text: "That got too long for me to finish. Try a simpler request." };
      stopReason = "max_tokens";
      break;
    }

    if (overBudget && calls.length > 0) {
      // Its tool calls never run, so this reply isn't kept (a call without a result can't be sent back).
      yield { type: "notice", text: "I stopped here because this request reached its usage limit. Ask again to continue." };
      stopReason = "usage_limit";
      break;
    }

    // Output items are valid input items: the conversation goes back exactly as sent.
    input.push(...(response.output as AgentHistory));

    if (calls.length === 0) {
      stopReason = response.status === "incomplete" ? "max_tokens" : "end_turn";
      break;
    }

    rounds += 1;
    const outcomes = await Promise.all(
      calls.map((call) => runTool(call.name, parseArguments(call.arguments), { api: deps.api, toolUseId: call.call_id })),
    );
    for (const [i, call] of calls.entries()) {
      yield { type: "tool_result", id: call.call_id, name: call.name, ok: !outcomes[i].isError };
      const ui = outcomes[i].ui;
      if (ui) yield ui;
      input.push({ type: "function_call_output", call_id: call.call_id, output: outcomes[i].content });
    }

    if (rounds >= maxRounds) {
      yield { type: "notice", text: `I stopped after ${maxRounds} steps. Tell me how you'd like to continue.` };
      stopReason = "max_tool_rounds";
      break;
    }
  }

  yield { type: "history", messages: input };
  yield { type: "done", stopReason };
}
