// ============================================================
// Tokento — Settlement: paying stores through PayPal Payouts
// ============================================================
// Shoppers pay Tokento's PayPal account; Tokento pays each store what it is owed
// in one Payouts batch per run: paid minus Tokento's fee for completed, unsettled
// orders, minus (paid - fee) for orders refunded after they were paid out.
// The batch id is PayPal's sender_batch_id, so PayPal refuses to pay it twice.
import { Prisma, type SettlementBatch } from '@prisma/client';
import { PayPalApiError, toPayPalAmount } from '@tokento/paypal';
import { CheckoutStatus, EventType, type SettlementBatchStatus, type SettlementPreview, type SettlementView } from '@tokento/shared';
import prisma from '../db/client';
import { emitEvent } from '../events/emitter';
import { getPayPal } from '../checkout/paypal';
import { AppError } from '../middleware/error.middleware';
import { logger } from '../utils/logger';
import { toMoneyNumber } from '../utils/money';

type Db = Prisma.TransactionClient | typeof prisma;
/** Batches whose money went, or is going, to the store. */
const PAID_OUT: SettlementBatchStatus[] = ['PENDING', 'PROCESSING', 'SUCCESS'];
const usd = (v: Prisma.Decimal) => `$${v.toFixed(2)}`;

async function candidates(db: Db, merchantId: string) {
  const [unsettled, refunded] = await Promise.all([
    db.checkoutOrder.findMany({
      where: { merchantId, status: CheckoutStatus.COMPLETED, settlementId: null },
      select: { id: true, amountToPay: true, platformFee: true },
    }),
    db.checkoutOrder.findMany({
      where: { merchantId, status: CheckoutStatus.REFUNDED, refundNettedSettlementId: null, settlement: { is: { status: { in: PAID_OUT } } } },
      select: { id: true, amountToPay: true, platformFee: true },
    }),
  ]);
  const zero = new Prisma.Decimal(0);
  const gross = unsettled.reduce((sum, o) => sum.plus(o.amountToPay), zero);
  const fees = unsettled.reduce((sum, o) => sum.plus(o.platformFee), zero);
  const refundAdjustments = refunded.reduce((sum, o) => sum.plus(o.amountToPay).minus(o.platformFee), zero);
  return { unsettled, refunded, gross, fees, refundAdjustments, net: gross.minus(fees).minus(refundAdjustments) };
}

function paypalStatusToOurs(paypalStatus: string): SettlementBatchStatus {
  if (paypalStatus === 'SUCCESS') return 'SUCCESS';
  if (paypalStatus === 'DENIED') return 'DENIED';
  if (paypalStatus === 'FAILED' || paypalStatus === 'CANCELED') return 'FAILED';
  return 'PROCESSING';
}

export class SettlementService {
  async preview(merchantId: string): Promise<SettlementPreview> {
    const [c, merchant] = await Promise.all([
      candidates(prisma, merchantId),
      prisma.merchant.findUnique({ where: { id: merchantId }, select: { paypalPayoutEmail: true } }),
    ]);
    return {
      orders: c.unsettled.length,
      gross: toMoneyNumber(c.gross),
      fees: toMoneyNumber(c.fees),
      refundAdjustments: toMoneyNumber(c.refundAdjustments),
      net: toMoneyNumber(c.net),
      payable: c.unsettled.length > 0 && c.net.greaterThan(0),
      receiverEmail: merchant?.paypalPayoutEmail ?? null,
    };
  }

  /** "Settle now": claim the orders and create the batch in one transaction, then send one PayPal payout. */
  async settle(merchantId: string): Promise<SettlementView> {
    const merchant = await prisma.merchant.findUnique({ where: { id: merchantId }, select: { paypalPayoutEmail: true, isSandbox: true } });
    if (!merchant?.paypalPayoutEmail) {
      throw new AppError(409, 'payout_email_missing', "Add the store's PayPal email for payouts before settling.");
    }
    const receiverEmail = merchant.paypalPayoutEmail;

    const { batch, gross, fees, refundAdjustments, orderCount } = await prisma.$transaction(async (tx) => {
      // One settlement run per store at a time.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`settle:${merchantId}`}))`;
      const c = await candidates(tx, merchantId);
      if (c.unsettled.length === 0 || !c.net.greaterThan(0)) {
        throw new AppError(409, 'nothing_to_settle', 'Nothing to pay out yet.');
      }
      const created = await tx.settlementBatch.create({
        data: { merchantId, status: 'PENDING', gross: c.gross, fees: c.fees, refundAdjustments: c.refundAdjustments, net: c.net, receiverEmail, isSandbox: merchant.isSandbox },
      });
      await tx.checkoutOrder.updateMany({ where: { id: { in: c.unsettled.map((o) => o.id) }, settlementId: null }, data: { settlementId: created.id } });
      if (c.refunded.length > 0) {
        await tx.checkoutOrder.updateMany({ where: { id: { in: c.refunded.map((o) => o.id) }, refundNettedSettlementId: null }, data: { refundNettedSettlementId: created.id } });
      }
      return { batch: created, gross: c.gross, fees: c.fees, refundAdjustments: c.refundAdjustments, orderCount: c.unsettled.length };
    });

    let sent: SettlementBatch;
    try {
      const res = await getPayPal().createPayoutBatch({
        senderBatchId: batch.id,
        emailSubject: 'Your Tokento payout for agent sales',
        items: [{
          receiverEmail,
          amount: toPayPalAmount(batch.net),
          currency: 'USD',
          senderItemId: batch.id,
          note: `${orderCount} agent order${orderCount === 1 ? '' : 's'}: ${usd(gross)} paid, ${usd(fees)} Tokento fees${refundAdjustments.greaterThan(0) ? `, ${usd(refundAdjustments)} refunds netted` : ''}.`.slice(0, 255),
        }],
      });
      sent = await prisma.settlementBatch.update({
        where: { id: batch.id },
        data: { paypalPayoutBatchId: res.batch_header.payout_batch_id, status: paypalStatusToOurs(res.batch_header.batch_status) },
      });
    } catch (err) {
      await this.release(batch.id, 'FAILED', err instanceof PayPalApiError ? `${err.name}${err.debugId ? ` (debug_id ${err.debugId})` : ''}` : 'PayPal unreachable');
      logger.error({ err, settlementId: batch.id }, 'Payout failed; orders released');
      if (err instanceof PayPalApiError) {
        throw new AppError(502, 'paypal_unavailable', 'PayPal could not send the payout. Nothing was paid; try again.', { paypalError: err.name, debugId: err.debugId });
      }
      throw err;
    }

    emitEvent(EventType.SETTLEMENT_CREATED, {
      merchantId, settlementId: sent.id, status: sent.status, net: toMoneyNumber(sent.net), paypalPayoutBatchId: sent.paypalPayoutBatchId,
    });
    return this.view(sent);
  }

  /** PayPal's word on a payout batch (webhook or refresh). Denied or failed batches release their orders. */
  async applyPayoutUpdate(paypalPayoutBatchId: string, paypalStatus: string): Promise<SettlementBatch | null> {
    const batch = await prisma.settlementBatch.findUnique({ where: { paypalPayoutBatchId } });
    if (!batch) return null;
    const status = paypalStatusToOurs(paypalStatus);
    if (batch.status === status || batch.status === 'SUCCESS' || batch.status === 'DENIED' || batch.status === 'FAILED') return batch;
    const updated = status === 'DENIED' || status === 'FAILED'
      ? await this.release(batch.id, status, `PayPal reported ${paypalStatus}`)
      : await prisma.settlementBatch.update({ where: { id: batch.id }, data: { status, ...(status === 'SUCCESS' ? { completedAt: new Date() } : {}) } });
    emitEvent(EventType.SETTLEMENT_UPDATED, { merchantId: updated.merchantId, settlementId: updated.id, status: updated.status });
    return updated;
  }

  async list(merchantId: string, limit = 50): Promise<SettlementView[]> {
    const batches = await prisma.settlementBatch.findMany({ where: { merchantId }, orderBy: { createdAt: 'desc' }, take: limit });
    // Webhooks normally move batches on; if one is still processing after a minute, ask PayPal.
    const stale = batches.filter((b) => b.status === 'PROCESSING' && b.paypalPayoutBatchId && Date.now() - b.updatedAt.getTime() > 60_000).slice(0, 5);
    for (const b of stale) {
      try {
        const res = await getPayPal().getPayoutBatch(b.paypalPayoutBatchId!);
        const updated = await this.applyPayoutUpdate(b.paypalPayoutBatchId!, res.batch_header.batch_status);
        if (updated) Object.assign(b, updated);
      } catch (err) {
        logger.warn({ err, settlementId: b.id }, 'Could not refresh payout status');
      }
    }
    return Promise.all(batches.map((b) => this.view(b)));
  }

  private async release(batchId: string, status: SettlementBatchStatus, error: string): Promise<SettlementBatch> {
    return prisma.$transaction(async (tx) => {
      await tx.checkoutOrder.updateMany({ where: { settlementId: batchId }, data: { settlementId: null } });
      await tx.checkoutOrder.updateMany({ where: { refundNettedSettlementId: batchId }, data: { refundNettedSettlementId: null } });
      return tx.settlementBatch.update({ where: { id: batchId }, data: { status, error: error.slice(0, 500) } });
    });
  }

  async view(batch: SettlementBatch): Promise<SettlementView> {
    const orders = await prisma.checkoutOrder.findMany({ where: { settlementId: batch.id }, select: { redemptionSettlementRef: true } });
    return {
      id: batch.id,
      status: batch.status as SettlementBatchStatus,
      orders: orders.length,
      gross: toMoneyNumber(batch.gross),
      fees: toMoneyNumber(batch.fees),
      refundAdjustments: toMoneyNumber(batch.refundAdjustments),
      net: toMoneyNumber(batch.net),
      receiverEmail: batch.receiverEmail,
      paypalPayoutBatchId: batch.paypalPayoutBatchId,
      settlementRefs: orders.map((o) => o.redemptionSettlementRef).filter((r): r is string => Boolean(r)),
      error: batch.error,
      createdAt: batch.createdAt.toISOString(),
      completedAt: batch.completedAt?.toISOString() ?? null,
    };
  }
}

export const settlementService = new SettlementService();
