import path from "node:path";
import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";

// The monorepo keeps one .env at its root; Next only reads the app folder's.
loadEnv({ path: path.resolve(process.cwd(), "../../.env") });

const nextConfig: NextConfig = {
  // The Anthropic SDK and the session code only ever run on the server.
  serverExternalPackages: ["@anthropic-ai/sdk"],
};

export default nextConfig;
