import { describe, expect, it } from "vitest";
import { CheckoutStatus, type CheckoutOrderView } from "@tokento/shared";
import { featuredOrder, orderIdFromSearch } from "../src/app/components/order-link";

const ID = "3f6c2a8e-5b1d-4c7a-9e2f-1a2b3c4d5e6f";

function order(id: string, createdAt: string, status = CheckoutStatus.COMPLETED): CheckoutOrderView {
  return { id, status, createdAt } as CheckoutOrderView;
}

describe("orderIdFromSearch", () => {
  it("reads the order the shopper came from", () => {
    expect(orderIdFromSearch(`?order=${ID}`)).toBe(ID);
    expect(orderIdFromSearch(`?theme=dark&order=${ID}`)).toBe(ID);
  });

  it("ignores a missing or malformed order id", () => {
    expect(orderIdFromSearch("")).toBeNull();
    expect(orderIdFromSearch("?order=")).toBeNull();
    expect(orderIdFromSearch("?order=1;DROP TABLE")).toBeNull();
    expect(orderIdFromSearch("?order=../../merchants/me")).toBeNull();
  });
});

describe("featuredOrder", () => {
  const older = order(ID, "2026-11-07T10:00:00.000Z");
  const newest = order("b1b1b1b1-0000-4000-8000-000000000001", "2026-11-07T11:00:00.000Z");

  it("shows the latest order when nobody asked for a particular one", () => {
    expect(featuredOrder([older, newest], null, null)).toEqual({ order: newest, focused: false });
  });

  it("shows the order the shopper came from, even when a newer one exists", () => {
    expect(featuredOrder([older, newest], ID, null)).toEqual({ order: older, focused: true });
  });

  it("prefers the live copy in the list, so status changes show up", () => {
    const refunded = order(ID, "2026-11-07T10:00:00.000Z", CheckoutStatus.REFUNDED);
    const fetchedBeforeRefund = order(ID, "2026-11-07T10:00:00.000Z");
    expect(featuredOrder([refunded, newest], ID, fetchedBeforeRefund).order?.status).toBe(CheckoutStatus.REFUNDED);
  });

  it("uses the separately loaded order when it is too old for the list", () => {
    expect(featuredOrder([newest], ID, older)).toEqual({ order: older, focused: true });
  });

  it("falls back to the latest order when the asked-for one can't be found", () => {
    expect(featuredOrder([newest], ID, null)).toEqual({ order: newest, focused: false });
  });
});
