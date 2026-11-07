// Shared wrapper for the shopper app's own API routes: require the session
// cookie, call Tokento with it, and pass Tokento's errors through unchanged.
import { readSession } from "./session";
import { TokentoApiError, tokentoClient, type TokentoClient } from "./tokento";

export async function withShopper(fn: (api: TokentoClient) => Promise<unknown>): Promise<Response> {
  const session = await readSession();
  if (!session) {
    return Response.json({ error: { code: "no_session", message: "Start a shopping session first." } }, { status: 401 });
  }
  try {
    return Response.json(await fn(tokentoClient(session.token)));
  } catch (err) {
    if (err instanceof TokentoApiError) {
      return Response.json({ error: { code: err.code, message: err.message, details: err.details } }, { status: err.status });
    }
    return Response.json({ error: { code: "tokento_unreachable", message: "Could not reach Tokento. Try again." } }, { status: 502 });
  }
}
