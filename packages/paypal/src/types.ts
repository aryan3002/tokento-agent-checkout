// ============================================================
// PayPal REST shapes used by Tokento (subset of the public API)
// ============================================================

export type PayPalEnv = 'sandbox' | 'live';

export interface PayPalClientConfig {
  clientId: string;
  clientSecret: string;
  env: PayPalEnv;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Injected for tests; defaults to Date.now. */
  now?: () => number;
  /** Per-request timeout. Defaults to 20 s. */
  timeoutMs?: number;
}

export interface RequestOptions {
  /** Sent as PayPal-Request-Id so a retried call cannot create a second order, capture, refund or token. */
  requestId: string;
}

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

export interface PayPalMoney {
  currency_code: string;
  value: string;
}

export type CaptureStatus = 'COMPLETED' | 'DECLINED' | 'PARTIALLY_REFUNDED' | 'PENDING' | 'REFUNDED' | 'FAILED';

export interface PayPalCapture {
  id: string;
  status: CaptureStatus;
  amount: PayPalMoney;
  custom_id?: string;
  invoice_id?: string;
  final_capture?: boolean;
  status_details?: { reason?: string };
  seller_receivable_breakdown?: {
    gross_amount?: PayPalMoney;
    paypal_fee?: PayPalMoney;
    net_amount?: PayPalMoney;
  };
  supplementary_data?: { related_ids?: { order_id?: string } };
  create_time?: string;
  update_time?: string;
  links?: PayPalLink[];
}

export type OrderStatus = 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';

export interface PayPalOrder {
  id: string;
  status: OrderStatus;
  intent?: string;
  payment_source?: {
    paypal?: {
      email_address?: string;
      account_id?: string;
      account_status?: string;
      name?: { given_name?: string; surname?: string };
      attributes?: { vault?: { id?: string; status?: string; customer?: { id: string } } };
    };
  };
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    invoice_id?: string;
    description?: string;
    amount?: PayPalMoney;
    payments?: { captures?: PayPalCapture[] };
  }>;
  links?: PayPalLink[];
}

export interface OrderItemInput {
  name: string;
  quantity: number;
  /** Two-decimal string, e.g. "28.00". */
  unitAmount: string;
  sku?: string;
}

export type OrderPayment =
  /** The buyer approves in PayPal (redirect or JS SDK popup). */
  | { kind: 'approval'; returnUrl: string; cancelUrl: string; brandName?: string }
  /** Charge a PayPal account the buyer saved earlier (Vault v3 payment token). */
  | { kind: 'vault'; vaultId: string };

export interface CreateOrderInput {
  /** Our checkout id. Comes back on the capture and in webhooks. */
  customId: string;
  invoiceId?: string;
  description: string;
  /** Amount the buyer pays, two-decimal string. */
  amount: string;
  currency: 'USD';
  /** Optional breakdown so the PayPal review page shows the reward as a discount. */
  breakdown?: { itemTotal: string; discount?: string };
  items?: OrderItemInput[];
  payment: OrderPayment;
}

export type RefundStatus = 'CANCELLED' | 'FAILED' | 'PENDING' | 'COMPLETED';

export interface PayPalRefund {
  id: string;
  status: RefundStatus;
  amount?: PayPalMoney;
  status_details?: { reason?: string };
  links?: PayPalLink[];
}

export interface RefundInput {
  /** Omit for a full refund. */
  amount?: string;
  note?: string;
}

export interface PayoutItemInput {
  receiverEmail: string;
  amount: string;
  currency: 'USD';
  senderItemId: string;
  note?: string;
}

export interface CreatePayoutBatchInput {
  /** Our settlement batch id. PayPal refuses a second batch with the same id. */
  senderBatchId: string;
  emailSubject: string;
  items: PayoutItemInput[];
}

export type PayoutBatchStatus = 'DENIED' | 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'CANCELED';

export interface PayPalPayoutBatch {
  batch_header: {
    payout_batch_id: string;
    batch_status: PayoutBatchStatus;
    sender_batch_header: { sender_batch_id: string; email_subject?: string };
    amount?: { value: string; currency: string };
    fees?: { value: string; currency: string };
    time_created?: string;
    time_completed?: string;
  };
  items?: Array<{
    payout_item_id: string;
    transaction_id?: string;
    transaction_status?: string;
    payout_item: { receiver: string; amount: { value: string; currency: string }; sender_item_id?: string; note?: string };
    errors?: { name?: string; message?: string };
  }>;
  links?: PayPalLink[];
}

export interface CreateSetupTokenInput {
  returnUrl: string;
  cancelUrl: string;
  /** Shown to the buyer on the PayPal consent page. */
  description: string;
  brandName?: string;
}

export interface PayPalSetupToken {
  id: string;
  status: string;
  customer?: { id: string };
  links?: PayPalLink[];
}

export interface PayPalPaymentToken {
  id: string;
  customer?: { id: string };
  payment_source?: { paypal?: { email_address?: string; payer_id?: string } };
  links?: PayPalLink[];
}

export interface VerifyWebhookInput {
  /** Request headers, lower-cased as Node/Express provides them. */
  headers: Record<string, string | string[] | undefined>;
  /** The parsed webhook body, exactly as received. */
  event: unknown;
  /** Id of the webhook registered for this app. */
  webhookId: string;
}

export interface PayPalWebhook {
  id: string;
  url: string;
  event_types?: Array<{ name: string }>;
}
