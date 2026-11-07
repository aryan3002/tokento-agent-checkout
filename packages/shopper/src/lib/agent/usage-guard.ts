// Guardrails on what the agent can spend on the model. Azure caps throughput
// (the deployment's tokens-per-minute) and a budget alert watches the month;
// this guard caps money per day, per request and per shopper inside the app.
// In memory: one server process, reset on restart; Azure's caps stay as backstops.
import type { AgentHistory } from "./events";

/** Dollars per million tokens. */
export interface Prices {
  input: number;
  cachedInput: number;
  output: number;
}

export interface GuardLimits {
  dailyBudgetUsd: number;
  turnBudgetUsd: number;
  turnsPerHour: number;
  prices: Prices;
}

export interface ModelUsage {
  input_tokens: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  output_tokens: number;
}

export type Admission = { ok: true } | { ok: false; message: string };

const HOUR = 3600_000;

function num(raw: string | undefined, fallback: number): number {
  const v = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Defaults: gpt-5.5 Global Standard list prices (Azure, Nov 2026), $10 a day, $0.75 a request, 30 requests an hour. */
export function readGuardLimits(env: Record<string, string | undefined>): GuardLimits {
  return {
    dailyBudgetUsd: num(env.AGENT_DAILY_BUDGET_USD, 10),
    turnBudgetUsd: num(env.AGENT_TURN_BUDGET_USD, 0.75),
    turnsPerHour: Math.floor(num(env.AGENT_TURNS_PER_HOUR, 30)),
    prices: {
      input: num(env.AGENT_PRICE_INPUT_PER_M, 5),
      cachedInput: num(env.AGENT_PRICE_CACHED_INPUT_PER_M, 0.5),
      output: num(env.AGENT_PRICE_OUTPUT_PER_M, 30),
    },
  };
}

export function costOf(usage: ModelUsage, prices: Prices): number {
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const uncached = Math.max(usage.input_tokens - cached, 0);
  return (uncached * prices.input + cached * prices.cachedInput + usage.output_tokens * prices.output) / 1_000_000;
}

export class UsageGuard {
  private day = "";
  private spent = 0;
  private turns = new Map<string, number[]>();

  constructor(
    private readonly limits: GuardLimits,
    private readonly now: () => number = Date.now,
  ) {}

  private rollDay() {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.spent = 0;
    }
  }

  spentToday(): number {
    this.rollDay();
    return this.spent;
  }

  /** Call before each request; counts it toward the shopper's hourly limit when admitted. */
  admit(shopperId: string): Admission {
    if (this.spentToday() >= this.limits.dailyBudgetUsd) {
      return { ok: false, message: "The demo agent reached today's usage limit. It resets at midnight UTC." };
    }
    const since = this.now() - HOUR;
    const recent = (this.turns.get(shopperId) ?? []).filter((t) => t > since);
    if (recent.length >= this.limits.turnsPerHour) {
      this.turns.set(shopperId, recent);
      return { ok: false, message: "You've sent a lot of requests in the last hour. Try again in a few minutes." };
    }
    recent.push(this.now());
    this.turns.set(shopperId, recent);
    return { ok: true };
  }

  /** A meter for one request: charges every model call and says when to stop. */
  meter(): (usage: ModelUsage) => { stop: boolean } {
    let turnSpent = 0;
    return (usage) => {
      const cost = costOf(usage, this.limits.prices);
      this.rollDay();
      this.spent += cost;
      turnSpent += cost;
      return { stop: turnSpent >= this.limits.turnBudgetUsd || this.spent >= this.limits.dailyBudgetUsd };
    };
  }
}

const isShopperMessage = (item: unknown) =>
  typeof item === "object" && item !== null && (item as { role?: string }).role === "user" && ((item as { type?: string }).type ?? "message") === "message";

/**
 * Every request resends the whole conversation, so a long chat costs more each turn.
 * Past maxBytes, drop the oldest turns, cutting only where a shopper message starts
 * so no tool call loses its result.
 */
export function trimHistory(history: AgentHistory, maxBytes: number): AgentHistory {
  if (JSON.stringify(history).length <= maxBytes) return history;
  let lastStart = -1;
  for (let i = 1; i < history.length; i++) {
    if (!isShopperMessage(history[i])) continue;
    lastStart = i;
    const candidate = history.slice(i);
    if (JSON.stringify(candidate).length <= maxBytes) return candidate;
  }
  return lastStart === -1 ? history : history.slice(lastStart);
}
