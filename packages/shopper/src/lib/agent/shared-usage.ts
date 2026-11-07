// The hosted demo's shared spend guard. Serverless instances each have their own
// memory, so the daily budget and the per-shopper hourly limit are counted in the
// Tokento API's Redis instead, through two internal routes only this server can
// call (AGENT_USAGE_KEY, a secret the API holds too). It protects real money, so
// when it can't be checked the request is refused rather than let through.
import { apiBase, type FetchLike } from "../tokento";
import { costOf, type Admission, type ModelUsage, type Prices } from "./usage-guard";

export interface SharedUsage {
  admit(customerId: string): Promise<Admission>;
  charge(costUsd: number): Promise<{ stop: boolean }>;
}

const UNAVAILABLE = "The shopping assistant is unavailable right now. Please try again in a minute.";

export function sharedUsage(opts: { apiUrl: string; key: string; fetchImpl?: FetchLike }): SharedUsage {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.apiUrl.replace(/\/+$/, "");
  async function post<T>(route: "admit" | "charge", body: unknown): Promise<T | null> {
    try {
      const res = await fetchImpl(`${base}/api/v1/internal/agent-usage/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-Usage-Key": opts.key },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  }
  return {
    async admit(customerId) {
      const answer = await post<{ ok: boolean; message?: string }>("admit", { customerId });
      if (!answer) return { ok: false, message: UNAVAILABLE };
      return answer.ok ? { ok: true } : { ok: false, message: answer.message ?? UNAVAILABLE };
    },
    async charge(costUsd) {
      const answer = await post<{ overBudget: boolean }>("charge", { costUsd });
      return { stop: answer ? answer.overBudget : true };
    },
  };
}

/** The shared guard when this server has the key (32+ characters), else null (local counting only). */
export function readSharedUsage(env: Record<string, string | undefined>, fetchImpl?: FetchLike): SharedUsage | null {
  const key = env.AGENT_USAGE_KEY?.trim() ?? "";
  if (key.length < 32) return null;
  return sharedUsage({ apiUrl: env.TOKENTO_API_URL?.trim() || apiBase(), key, fetchImpl });
}

/** The per-request meter plus the shared daily total: stop when either says so. */
export function combinedMeter(
  local: (usage: ModelUsage) => { stop: boolean },
  shared: SharedUsage,
  prices: Prices,
): (usage: ModelUsage) => Promise<{ stop: boolean }> {
  return async (usage) => {
    const here = local(usage);
    const everywhere = await shared.charge(costOf(usage, prices));
    return { stop: here.stop || everywhere.stop };
  };
}
