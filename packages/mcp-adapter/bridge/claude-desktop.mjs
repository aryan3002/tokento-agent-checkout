#!/usr/bin/env node
// ============================================================
// Tokento — Claude Desktop bridge (stdio ↔ the MCP Worker over HTTP)
// ============================================================
// Claude Desktop starts local MCP servers as programs that speak JSON-RPC on
// stdin/stdout. The Tokento MCP server is an HTTP Worker, so this script sits
// between them. No dependencies: plain Node 18+.
//
//   TOKENTO_MCP_URL        where the Worker runs (default http://127.0.0.1:8787)
//   TOKENTO_WALLET_TOKEN   optional: the shopper's wallet token. When set, the bridge
//                          sends it on every tool call and hides the wallet_token
//                          argument from the model, so the token never appears in
//                          the chat and the model can't swap in another one.
//   TOKENTO_MCP_AUTH       optional: sent as X-MCP-Auth if the Worker requires it.
//
// stdout carries protocol messages only; anything for a human goes to stderr.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const DEFAULT_URL = 'http://127.0.0.1:8787';

function hideWalletToken(result) {
  if (!result || !Array.isArray(result.tools)) return result;
  return {
    ...result,
    tools: result.tools.map((tool) => {
      const schema = tool.inputSchema;
      if (!schema?.properties || !('wallet_token' in schema.properties)) return tool;
      const { wallet_token: _hidden, ...properties } = schema.properties;
      const required = (schema.required ?? []).filter((name) => name !== 'wallet_token');
      return { ...tool, inputSchema: { ...schema, properties, required } };
    }),
  };
}

/**
 * Handle one line from Claude Desktop. Returns the JSON-RPC message to write
 * back, or null when nothing should be written (notifications).
 */
export async function handleLine(text, { post, walletToken = '', url = DEFAULT_URL }) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  }

  // Notifications (no id) never get a reply. The Worker has nothing to do with them.
  if (msg.id === undefined || msg.id === null) return null;
  if (msg.method === 'ping') return { jsonrpc: '2.0', id: msg.id, result: {} };

  let outgoing = msg;
  if (walletToken && msg.method === 'tools/call') {
    const params = msg.params ?? {};
    outgoing = { ...msg, params: { ...params, arguments: { ...(params.arguments ?? {}), wallet_token: walletToken } } };
  }

  let reply;
  try {
    reply = await post(outgoing);
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      error: {
        code: -32603,
        message: `The Tokento MCP server isn't reachable at ${url} (${err instanceof Error ? err.message : String(err)}). Start it with: pnpm --filter @tokento/mcp-adapter dev:hosted`,
      },
    };
  }

  if (walletToken && msg.method === 'tools/list' && reply?.result) {
    return { ...reply, result: hideWalletToken(reply.result) };
  }
  return reply;
}

function httpPost(url, auth) {
  return async (body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers['X-MCP-Auth'] = auth;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status} with a non-JSON body`);
    }
  };
}

async function main() {
  const url = process.env.TOKENTO_MCP_URL?.trim() || DEFAULT_URL;
  const walletToken = process.env.TOKENTO_WALLET_TOKEN?.trim() || '';
  const post = httpPost(url, process.env.TOKENTO_MCP_AUTH?.trim() || '');
  process.stderr.write(`tokento bridge → ${url}${walletToken ? ' (wallet token from config)' : ''}\n`);

  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on('line', async (text) => {
    if (!text.trim()) return;
    const out = await handleLine(text, { post, walletToken, url });
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
