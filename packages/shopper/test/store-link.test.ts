import { describe, expect, it } from "vitest";
import { storeViewUrl } from "../src/lib/store-link";

const ID = "3f6c2a8e-5b1d-4c7a-9e2f-1a2b3c4d5e6f";

describe("storeViewUrl", () => {
  it("links a paid order to the store dashboard, opened on that order", () => {
    expect(storeViewUrl("https://tokento-dashboard.vercel.app", { id: ID, status: "COMPLETED" })).toBe(`https://tokento-dashboard.vercel.app/?order=${ID}`);
  });

  it("ignores a trailing slash or path on the dashboard address", () => {
    expect(storeViewUrl("http://localhost:3100/", { id: ID, status: "COMPLETED" })).toBe(`http://localhost:3100/?order=${ID}`);
    expect(storeViewUrl("http://localhost:3100/some/page", { id: ID, status: "COMPLETED" })).toBe(`http://localhost:3100/?order=${ID}`);
  });

  it("still links once the payment was refunded, since the store sees that too", () => {
    expect(storeViewUrl("http://localhost:3100", { id: ID, status: "REFUNDED" })).toBe(`http://localhost:3100/?order=${ID}`);
    expect(storeViewUrl("http://localhost:3100", { id: ID, status: "REFUND_PENDING" })).toBe(`http://localhost:3100/?order=${ID}`);
  });

  it("offers no link before money has moved", () => {
    for (const status of ["PENDING", "CREATED", "APPROVED", "CAPTURE_PENDING", "CANCELLED", "FAILED"]) {
      expect(storeViewUrl("http://localhost:3100", { id: ID, status })).toBeNull();
    }
  });

  it("offers no link when the dashboard address is missing or broken", () => {
    expect(storeViewUrl("", { id: ID, status: "COMPLETED" })).toBeNull();
    expect(storeViewUrl("not a url", { id: ID, status: "COMPLETED" })).toBeNull();
  });
});
