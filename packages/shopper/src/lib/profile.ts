// The shopping agent's memory of its user. In a real assistant this would be the
// user's saved preferences; here every demo shopper is "Maya". Fictional.
export const SHOPPER_PROFILE = {
  name: "Maya",
  usualItems: [
    "Medium roast whole bean coffee, 2 lb bag (she grinds at home). Caffeinated, never decaf.",
  ],
  preferences: [
    "Whole bean over ground.",
    "Wants the best total value, counting store rewards, not just the lowest sticker price.",
    "Likes a one-line reason for every pick.",
  ],
} as const;

/** Maya's customer id in the seeded demo data (packages/api/src/demo/demo-data.ts). */
export const DEMO_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
