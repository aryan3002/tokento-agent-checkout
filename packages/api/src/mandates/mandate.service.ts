// ============================================================
// Tokento — Spending mandates
// ============================================================
// What a shopper lets an agent spend without asking. Filled in with real limits
// later; until then every purchase counts as inside the mandate.
import type { Mandate, Prisma } from '@prisma/client';
import type { MandateViolationCode } from '@tokento/shared';

export type MandateDecision =
  | { within: true; mandate: Mandate | null }
  | { within: false; code: MandateViolationCode; message: string; mandate: Mandate | null };

export class MandateService {
  async evaluate(
    _customerId: string,
    _purchase: { merchantId: string; amount: Prisma.Decimal },
    _now: Date = new Date(),
  ): Promise<MandateDecision> {
    return { within: true, mandate: null };
  }
}

export const mandateService = new MandateService();
