// POST /api/chat — one turn of the shopping agent, streamed as NDJSON events.
// The browser keeps the conversation and sends it back each turn; the server
// appends to it and never edits earlier turns.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { runAgentTurn } from "@/lib/agent/loop";
import { readSession } from "@/lib/session";
import { tokentoClient } from "@/lib/tokento";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({
  message: z.string().min(1).max(2000),
  history: z.array(z.any()).max(400).default([]),
});

export async function POST(request: Request) {
  const session = await readSession();
  if (!session) {
    return Response.json({ error: { code: "no_session", message: "Start a shopping session first." } }, { status: 401 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: { code: "agent_not_configured", message: "The shopping agent is not configured on this server." } }, { status: 503 });
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: { code: "invalid_request", message: "Send { message, history }." } }, { status: 400 });
  }

  const claude = new Anthropic();
  const api = tokentoClient(session.token);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of runAgentTurn({ claude, api }, parsed.data.history, parsed.data.message)) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      } catch {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", message: "Something went wrong. Please try again." })}\n`));
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "done", stopReason: "error" })}\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
  });
}
