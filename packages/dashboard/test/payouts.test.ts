import { describe, expect, it } from "vitest";
import { payoutStatus, previewBreakdown } from "../src/app/components/payouts";

describe("payout status", () => {
  it("names each PayPal payout state in plain words with a tone", () => {
    expect(payoutStatus("SUCCESS")).toEqual({ label: "Paid out", tone: "success" });
    expect(payoutStatus("PROCESSING")).toEqual({ label: "Sending", tone: "warning" });
    expect(payoutStatus("PENDING")).toEqual({ label: "Sending", tone: "warning" });
    expect(payoutStatus("DENIED")).toEqual({ label: "Denied by PayPal", tone: "error" });
    expect(payoutStatus("FAILED")).toEqual({ label: "Failed", tone: "error" });
  });
});

describe("previewBreakdown", () => {
  it("explains what Settle now would pay, leaving out zero lines", () => {
    expect(previewBreakdown({ orders: 2, gross: 46, fees: 0.92, refundAdjustments: 0, net: 45.08, payable: true, receiverEmail: "x" }))
      .toBe("2 paid orders: $46.00 − $0.92 Tokento fees");
    expect(previewBreakdown({ orders: 1, gross: 33, fees: 0.66, refundAdjustments: 22.54, net: 9.8, payable: true, receiverEmail: "x" }))
      .toBe("1 paid order: $33.00 − $0.66 Tokento fees − $22.54 refunds already paid out");
    expect(previewBreakdown({ orders: 0, gross: 0, fees: 0, refundAdjustments: 0, net: 0, payable: false, receiverEmail: null }))
      .toBe("No paid orders waiting.");
  });
});
