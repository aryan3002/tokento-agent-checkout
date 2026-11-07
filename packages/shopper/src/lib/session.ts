// The shopper's Tokento session lives in an httpOnly cookie: the browser never
// sees it, and every Tokento call is made from this server with it.
import { cookies } from "next/headers";

export const SESSION_COOKIE = "tokento_shopper_session";
export const CUSTOMER_COOKIE = "tokento_shopper_id";

export interface ShopperSession {
  token: string;
  customerId: string;
}

export async function readSession(): Promise<ShopperSession | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const customerId = jar.get(CUSTOMER_COOKIE)?.value;
  return token && customerId ? { token, customerId } : null;
}

export async function writeSession(session: ShopperSession): Promise<void> {
  const jar = await cookies();
  const options = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  };
  jar.set(SESSION_COOKIE, session.token, options);
  jar.set(CUSTOMER_COOKIE, session.customerId, options);
}
