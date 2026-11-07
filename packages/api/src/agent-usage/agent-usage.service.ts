// ============================================================
// Tokento — Shared spend guard for the hosted shopping agent
// ============================================================
// The shopper app runs on serverless instances that come and go, so counters in
// one instance's memory don't add up. These live in Redis instead: one daily
// spend total for the whole demo (in micro-dollars, so increments stay exact)
// and a per-shopper count of requests in each clock hour.
import type Redis from 'ioredis';
import { AppError } from '../middleware/error.middleware';

export interface AgentUsageLimits {
  dailyBudgetUsd: number;
  turnsPerHour: number;
}

export type UsageAdmission =
  | { ok: true }
  | { ok: false; code: 'daily_budget' | 'hourly_limit'; message: string };

const MICRO = 1_000_000;
/** No single model call costs this much (output is capped per call); anything above is a bug or abuse. */
const MAX_CALL_COST_USD = 10;

export function readAgentUsageLimits(env: Record<string, string | undefined>): AgentUsageLimits {
  const num = (v: string | undefined, fallback: number) => (v !== undefined && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
  return { dailyBudgetUsd: num(env.AGENT_DAILY_BUDGET_USD, 10), turnsPerHour: num(env.AGENT_TURNS_PER_HOUR, 30) };
}

type RedisLike = Pick<Redis, 'get' | 'incr' | 'incrby' | 'expire'>;

export class AgentUsageService {
  constructor(
    private readonly redis: RedisLike,
    private readonly limits: AgentUsageLimits,
    private readonly now: () => number = Date.now,
    private readonly prefix = 'agent-usage',
  ) {}

  private spendKey(): string {
    return `${this.prefix}:spend:${new Date(this.now()).toISOString().slice(0, 10)}`;
  }

  /** Call before each agent request; counts it toward the shopper's hour when admitted. */
  async admit(customerId: string): Promise<UsageAdmission> {
    const spent = Number((await this.redis.get(this.spendKey())) ?? 0) / MICRO;
    if (spent >= this.limits.dailyBudgetUsd) {
      return { ok: false, code: 'daily_budget', message: "The demo agent reached today's usage limit. It resets at midnight UTC." };
    }
    const hourKey = `${this.prefix}:turns:${customerId}:${new Date(this.now()).toISOString().slice(0, 13)}`;
    const turns = await this.redis.incr(hourKey);
    if (turns === 1) await this.redis.expire(hourKey, 2 * 3600);
    if (turns > this.limits.turnsPerHour) {
      return { ok: false, code: 'hourly_limit', message: "You've sent a lot of requests in the last hour. Try again in a few minutes." };
    }
    return { ok: true };
  }

  /** Add one model call's cost to today's total; overBudget tells the caller to stop. */
  async charge(costUsd: number): Promise<{ spentTodayUsd: number; overBudget: boolean }> {
    if (!Number.isFinite(costUsd) || costUsd < 0 || costUsd > MAX_CALL_COST_USD) {
      throw new AppError(400, 'invalid_cost', `costUsd must be between 0 and ${MAX_CALL_COST_USD}.`);
    }
    const key = this.spendKey();
    const total = await this.redis.incrby(key, Math.round(costUsd * MICRO));
    await this.redis.expire(key, 2 * 86_400);
    const spentTodayUsd = total / MICRO;
    return { spentTodayUsd, overBudget: spentTodayUsd >= this.limits.dailyBudgetUsd };
  }
}
