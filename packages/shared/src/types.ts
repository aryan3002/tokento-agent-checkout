// ============================================================
// Tokento — Shared Types
// ============================================================
// Canonical type definitions used across API, MCP adapter, and dashboard.
// Maps directly to the Token Architecture in the vault.

// ---- Token Types ----

export enum TokenType {
  LOYALTY = 'loyalty',
  // Phase 2:
  // PRICING = 'pricing',
  // RETURNS = 'returns',
}

export enum TokenStatus {
  ACTIVE = 'ACTIVE',
  REDEEMED = 'REDEEMED',
  EXPIRED = 'EXPIRED',
  /** Cancelled by a refund of the purchase that earned it. */
  VOIDED = 'VOIDED',
}

export enum SettlementType {
  DISCOUNT = 'discount',
  CASHBACK = 'cashback',
  CREDIT = 'credit',
}

export enum SettlementTiming {
  REAL_TIME = 'real_time',
  DAILY_BATCH = 'daily_batch',
}

// ---- Token Object ----

export interface Token {
  id: string;
  merchantId: string;
  customerId: string;
  earnRuleId: string;
  denomination: number;          // USD value
  tokenType: TokenType;
  status: TokenStatus;
  signature: string;              // HMAC-SHA256
  idempotencyKey: string;

  // Conditions
  categoryRestriction: string | null;
  channelRestriction: string | null;
  stackabilityFlag: boolean;
  agentPresentableFlag: boolean;
  minimumTransactionFloor: number;

  // Timestamps
  issuedAt: Date;
  expiryAt: Date;
  redeemedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;

  // Environment
  isSandbox: boolean;
}

// ---- Earn Rule ----

export interface EarnRule {
  id: string;
  merchantId: string;
  name: string;
  spendThreshold: number;        // Minimum spend to earn
  tokenDenomination: number;     // Token value awarded
  expiryDays: number;            // Days until token expires
  categoryRestriction: string | null;
  channelRestriction: string | null;
  stackabilityFlag: boolean;
  agentPresentableFlag: boolean; // Default ON per decision log
  minimumTransactionFloor: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ---- Merchant ----

export interface Merchant {
  id: string;
  name: string;
  email: string;
  agentOptIn: boolean;
  settlementType: SettlementType;
  settlementTiming: SettlementTiming;
  webhookUrl: string | null;
  webhookSecret: string | null;
  isSandbox: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ---- API Key ----

export interface ApiKey {
  id: string;
  merchantId: string;
  keyPrefix: string;            // First 8 chars, shown in dashboard
  keyHash: string;              // SHA-256 hash of full key
  scopes: string[];             // e.g., ['tokens:mint', 'tokens:read']
  rateLimit: number;            // Requests per minute
  isSandbox: boolean;
  isActive: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  expiresAt: Date | null;
}

// ---- Wallet ----

export interface Wallet {
  customerId: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---- Redemption ----

export interface Redemption {
  id: string;
  tokenId: string;
  merchantId: string;
  customerId: string;
  transactionAmount: number;
  tokenDenomination: number;
  netValue: number;              // transactionAmount - tokenDenomination
  agentId: string | null;        // Which agent initiated redemption
  redeemedAt: Date;
}

// ---- Audit Log ----

export interface AuditLog {
  id: string;
  method: string;
  endpoint: string;
  merchantId: string | null;
  customerId: string | null;
  tokenId: string | null;
  requestBody: Record<string, unknown> | null;
  responseCode: number;
  responseTimeMs: number;
  ipAddress: string | null;
  userAgent: string | null;
  timestamp: Date;
}

// ---- Webhook ----

export interface WebhookEndpoint {
  id: string;
  merchantId: string;
  url: string;
  secret: string;               // For signature verification
  events: string[];             // e.g., ['token.minted', 'token.redeemed']
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookDelivery {
  id: string;
  webhookEndpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
  responseCode: number | null;
  responseBody: string | null;
  attempts: number;
  nextRetryAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

// ---- API Request/Response Types ----

export interface MintTokenRequest {
  merchantId: string;
  customerId: string;
  transactionAmount: number;
  earnRuleId: string;
  idempotencyKey: string;
}

export interface MintTokenResponse {
  token: Token;
  walletCreated: boolean;
}

export interface WalletQueryParams {
  merchantId?: string;
  category?: string;
  channel?: string;
  tokenType?: TokenType;
  minDenomination?: number;
}

export interface WalletQueryResponse {
  customerId: string;
  tokens: Token[];
  totalValue: number;
}

export interface ValidateTokenRequest {
  transactionAmount: number;
  merchantId: string;
  channel?: string;
  agentId?: string;
}

export interface ValidateTokenResponse {
  valid: boolean;
  tokenId: string;
  denomination: number;
  reasonCode: string | null;     // null if valid, detailed reason if not
  reasonMessage: string | null;
}

export interface RedeemTokenRequest {
  transactionAmount: number;
  merchantId: string;
  agentId?: string;
  idempotencyKey: string;
}

/**
 * Settlement state for a redemption.
 *
 * `not_implemented` is the only value the platform currently returns: there is no
 * ledger, no double-entry journal and no payout pipeline, so no funds move. The
 * field exists so an integrator cannot mistake a recorded redemption for a
 * completed settlement.
 */
export type SettlementStatus = 'not_implemented' | 'pending' | 'settled';

export interface RedeemTokenResponse {
  redemptionId: string;
  tokenId: string;
  netTransactionValue: number;
  tokenDenomination: number;
  /**
   * Opaque correlation id. NOT a payment reference — settlement is not
   * implemented and no funds move. See settlementStatus.
   */
  settlementReference: string;
  settlementStatus: SettlementStatus;
  alreadyRedeemed: boolean;       // True if idempotent duplicate
}

// ---- Error Response ----

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  requestId: string;
}

// ---- Validation Reason Codes ----

export enum ValidationReasonCode {
  TOKEN_EXPIRED = 'token_expired',
  TOKEN_REDEEMED = 'token_redeemed',
  MERCHANT_MISMATCH = 'merchant_mismatch',
  AMOUNT_BELOW_FLOOR = 'amount_below_floor',
  NOT_AGENT_PRESENTABLE = 'not_agent_presentable',
  CHANNEL_MISMATCH = 'channel_mismatch',
  SIGNATURE_INVALID = 'signature_invalid',
  TOKEN_NOT_FOUND = 'token_not_found',
  SANDBOX_PRODUCTION_MISMATCH = 'sandbox_production_mismatch',
  TOKEN_VOIDED = 'token_voided',
}

// ---- Event Types ----

export enum EventType {
  TOKEN_MINTED = 'token.minted',
  TOKEN_REDEEMED = 'token.redeemed',
  TOKEN_EXPIRED = 'token.expired',
  TOKEN_VALIDATED = 'token.validated',
  MERCHANT_CREATED = 'merchant.created',
  EARN_RULE_CREATED = 'earn_rule.created',
  EARN_RULE_UPDATED = 'earn_rule.updated',
  WALLET_CREATED = 'wallet.created',
  WEBHOOK_DELIVERED = 'webhook.delivered',
  WEBHOOK_FAILED = 'webhook.failed',
  CHECKOUT_CREATED = 'checkout.created',
  CHECKOUT_COMPLETED = 'checkout.completed',
  CHECKOUT_REFUNDED = 'checkout.refunded',
  CHECKOUT_CANCELLED = 'checkout.cancelled',
  /** Any other status change: capture pending, needs review, failed. */
  CHECKOUT_UPDATED = 'checkout.updated',
  SETTLEMENT_CREATED = 'settlement.created',
  SETTLEMENT_UPDATED = 'settlement.updated',
  PAYPAL_WEBHOOK = 'paypal.webhook',
}

// ---- Agent checkout (PayPal) ----

export enum CheckoutStatus {
  /** Row written and the reward held; PayPal order not created yet. */
  PENDING = 'PENDING',
  /** PayPal order created; waiting for the shopper to approve. */
  CREATED = 'CREATED',
  APPROVED = 'APPROVED',
  /** PayPal accepted the capture but is holding the funds. */
  CAPTURE_PENDING = 'CAPTURE_PENDING',
  /** Money captured; reward redemption and earning in progress. */
  CAPTURED = 'CAPTURED',
  COMPLETED = 'COMPLETED',
  /** Captured amount did not match the order. Nothing redeemed or earned. */
  NEEDS_REVIEW = 'NEEDS_REVIEW',
  REFUND_PENDING = 'REFUND_PENDING',
  REFUNDED = 'REFUNDED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

export type PaymentMode = 'approval' | 'vault';

export type MandateViolationCode =
  | 'no_mandate'
  | 'expired'
  | 'store_not_allowed'
  | 'over_per_purchase_max'
  | 'over_monthly_cap';

/** One store's offer for a product, priced with the shopper's rewards. Amounts in USD. */
export interface OfferView {
  productId: string;
  productName: string;
  sku: string;
  merchantId: string;
  merchantName: string;
  unitPrice: number;
  quantity: number;
  subtotal: number;
  /** Reward that would be applied now, if any. */
  reward: { tokenId: string; amount: number } | null;
  /** What PayPal would charge. */
  amountToPay: number;
  /** Reward this purchase would earn at the same store, if any. */
  earn: { ruleId: string; ruleName: string; amount: number } | null;
  /** amountToPay minus the reward earned back. */
  effectiveCost: number;
  /** null when no budget was given. */
  withinBudget: boolean | null;
  mandate: { within: boolean; code?: MandateViolationCode; message?: string };
  /** Plain-language explanation the agent can repeat. */
  reason: string;
}

export interface QuoteResponse {
  offers: OfferView[];
  recommendedProductId: string | null;
  comparison: string;
}

export type SettlementState = 'unsettled' | 'processing' | 'paid' | 'failed';

export interface CheckoutOrderView {
  id: string;
  status: CheckoutStatus;
  customerId: string;
  merchant: { id: string; name: string };
  product: { id: string; name: string; sku: string };
  quantity: number;
  subtotal: number;
  /** tokenId is null once a released hold is cleared. */
  reward: { tokenId: string | null; amount: number; state: 'held' | 'redeemed' | 'released' | 'reissued' } | null;
  amountToPay: number;
  earned: { tokenId: string | null; amount: number; state: 'expected' | 'issued' | 'voided' | 'kept' } | null;
  paymentMode: PaymentMode;
  outsideMandate: boolean;
  paypal: { orderId: string | null; captureId: string | null; refundId: string | null; approvalUrl: string | null };
  platformFee: number;
  settlement: { batchId: string | null; state: SettlementState };
  agentReason: string | null;
  note: string | null;
  /** One-line receipt: price, reward used, paid with PayPal, reward earned. */
  receipt: string;
  createdAt: string;
  completedAt: string | null;
  refundedAt: string | null;
}

/**
 * A PayPal webhook about one of a store's orders, for the dashboard feed. Only
 * deliveries that passed PayPal's signature check are stored, so `verified` is true.
 * state: processed (handled), retrying (handling failed; PayPal redelivers), received (not handled yet).
 */
export interface PayPalEventView {
  id: string;
  eventType: string;
  summary: string | null;
  checkoutId: string | null;
  verified: boolean;
  state: 'processed' | 'retrying' | 'received';
  receivedAt: string;
}

/** A shopper's spending limits for agent purchases, as the shopper app shows them. Amounts in USD. */
export interface MandateView {
  id: string;
  status: 'ACTIVE' | 'REVOKED';
  perPurchaseMax: number;
  monthlyCap: number;
  allowedStores: { id: string; name: string }[];
  expiresAt: string;
  /** Open and completed agent orders this calendar month (UTC); refunded, cancelled and failed don't count. */
  spentThisMonth: number;
  remainingThisMonth: number;
  /** ACTIVE: PayPal is linked, so purchases inside the limits need no new approval. */
  vault: { status: 'NONE' | 'PENDING_APPROVAL' | 'ACTIVE' | 'FAILED' };
  createdAt: string;
  revokedAt: string | null;
}

export type SettlementBatchStatus = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'DENIED' | 'FAILED';

/** One PayPal Payouts batch to a store. Amounts in USD. */
export interface SettlementView {
  id: string;
  status: SettlementBatchStatus;
  orders: number;
  gross: number;
  fees: number;
  /** Refunds of orders that were already paid out, taken off this batch. */
  refundAdjustments: number;
  net: number;
  receiverEmail: string;
  paypalPayoutBatchId: string | null;
  /** The redemption settlement references of the orders this batch pays for. */
  settlementRefs: string[];
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** What "Settle now" would pay the store right now. */
export interface SettlementPreview {
  orders: number;
  gross: number;
  fees: number;
  refundAdjustments: number;
  net: number;
  payable: boolean;
  receiverEmail: string | null;
}
