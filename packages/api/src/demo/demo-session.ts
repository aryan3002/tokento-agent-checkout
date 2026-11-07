// Signed sessions for the hosted demo's visitors: demo_session::<customerId>::<exp>::<hmac>.
// Accepted only while DEMO_MODE=true; each one names a single fresh demo shopper.
import { createHmac, timingSafeEqual } from 'crypto';

const PREFIX = 'demo_session::';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mac = (customerId: string, exp: number, secret: string) =>
  createHmac('sha256', secret).update(`demo:${customerId}:${exp}`).digest('hex');

export function demoModeOn(): boolean {
  return process.env.DEMO_MODE === 'true';
}

/** The secret must be real: a short or default one would make sessions forgeable. */
export function demoSecret(): string {
  const secret = process.env.JWT_SECRET ?? '';
  if (secret.length < 32 || secret.startsWith('change-me')) throw new Error('JWT_SECRET must be set (32+ characters) for demo sessions');
  return secret;
}

export function signDemoSession(customerId: string, expiresAt: Date, secret: string): string {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return `${PREFIX}${customerId}::${exp}::${mac(customerId, exp, secret)}`;
}

export function isDemoSessionToken(token: string): boolean {
  return token.startsWith(PREFIX);
}

/** The customer id, or null for anything forged, malformed or expired. */
export function verifyDemoSession(token: string, secret: string, now: Date = new Date()): string | null {
  if (!isDemoSessionToken(token)) return null;
  const [customerId, expRaw, given] = token.slice(PREFIX.length).split('::');
  const exp = Number(expRaw);
  if (!customerId || !UUID.test(customerId) || !Number.isInteger(exp) || !given || !/^[0-9a-f]{64}$/.test(given)) return null;
  const expected = Buffer.from(mac(customerId, exp, secret), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(given, 'hex'))) return null;
  return exp * 1000 > now.getTime() ? customerId : null;
}
