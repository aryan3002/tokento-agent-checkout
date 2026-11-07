// The shopping agent's model: an Azure OpenAI deployment, reached through the
// resource's v1 API with the standard OpenAI SDK. Everything comes from env, so
// switching models is a new deployment name, not a code change.
import OpenAI from "openai";
import type { AgentModelConfig } from "./loop";

export interface AzureAgentConfig extends AgentModelConfig {
  endpoint: string;
  apiKey: string;
}

const EFFORTS = ["minimal", "low", "medium", "high"] as const;

/** `https://<resource>.openai.azure.com/openai/v1/`, however the endpoint was pasted. */
export function azureBaseUrl(endpoint: string): string {
  const origin = endpoint.trim().replace(/\/+$/, "").replace(/\/openai(\/v1)?$/, "");
  return `${origin}/openai/v1/`;
}

export function readAgentConfig(env: Record<string, string | undefined>): AzureAgentConfig | null {
  const endpoint = env.AZURE_OPENAI_ENDPOINT?.trim();
  const apiKey = env.AZURE_OPENAI_API_KEY?.trim();
  const deployment = env.AZURE_OPENAI_DEPLOYMENT?.trim();
  if (!endpoint || !apiKey || !deployment) return null;
  const effort = env.AZURE_OPENAI_REASONING_EFFORT?.trim().toLowerCase();
  const reasoningEffort = effort === "none" ? null : (EFFORTS as readonly string[]).includes(effort ?? "") ? (effort as AgentModelConfig["reasoningEffort"]) : "low";
  return { endpoint, apiKey, deployment, reasoningEffort };
}

export function createModelClient(config: AzureAgentConfig): OpenAI {
  // Azure's v1 API takes the key as a bearer token or an api-key header; send both.
  return new OpenAI({ apiKey: config.apiKey, baseURL: azureBaseUrl(config.endpoint), defaultHeaders: { "api-key": config.apiKey } });
}
