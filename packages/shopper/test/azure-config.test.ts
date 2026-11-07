import { describe, expect, it } from "vitest";
import { azureBaseUrl, readAgentConfig } from "../src/lib/agent/azure";

describe("Azure OpenAI config", () => {
  it("points the client at the resource's v1 API however the endpoint was pasted", () => {
    for (const endpoint of [
      "https://tokento-hack.openai.azure.com",
      "https://tokento-hack.openai.azure.com/",
      "https://tokento-hack.openai.azure.com/openai/",
      "https://tokento-hack.openai.azure.com/openai/v1",
    ]) {
      expect(azureBaseUrl(endpoint)).toBe("https://tokento-hack.openai.azure.com/openai/v1/");
    }
  });

  it("is configured only when the endpoint, key and deployment are all set", () => {
    const full = { TOKENTO_AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com", TOKENTO_AZURE_OPENAI_API_KEY: "k", TOKENTO_AZURE_OPENAI_DEPLOYMENT: "tokento-agent" };
    expect(readAgentConfig(full)).toEqual({ endpoint: "https://x.openai.azure.com", apiKey: "k", deployment: "tokento-agent", reasoningEffort: "low" });
    expect(readAgentConfig({ ...full, TOKENTO_AZURE_OPENAI_API_KEY: "" })).toBeNull();
    expect(readAgentConfig({ ...full, TOKENTO_AZURE_OPENAI_DEPLOYMENT: undefined })).toBeNull();
  });

  it("ignores a generic AZURE_OPENAI_API_KEY exported by the shell for another project", () => {
    const shell = { AZURE_OPENAI_ENDPOINT: "https://other.openai.azure.com", AZURE_OPENAI_API_KEY: "other-key", AZURE_OPENAI_DEPLOYMENT: "other" };
    expect(readAgentConfig(shell)).toBeNull();
    const ours = { TOKENTO_AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com", TOKENTO_AZURE_OPENAI_API_KEY: "k", TOKENTO_AZURE_OPENAI_DEPLOYMENT: "d" };
    expect(readAgentConfig({ ...shell, ...ours })).toMatchObject({ apiKey: "k", endpoint: "https://x.openai.azure.com" });
  });

  it("reads the reasoning effort, with 'none' for models that don't reason", () => {
    const base = { TOKENTO_AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com", TOKENTO_AZURE_OPENAI_API_KEY: "k", TOKENTO_AZURE_OPENAI_DEPLOYMENT: "d" };
    expect(readAgentConfig({ ...base, TOKENTO_AZURE_OPENAI_REASONING_EFFORT: "medium" })?.reasoningEffort).toBe("medium");
    expect(readAgentConfig({ ...base, TOKENTO_AZURE_OPENAI_REASONING_EFFORT: "none" })?.reasoningEffort).toBeNull();
    expect(readAgentConfig({ ...base, TOKENTO_AZURE_OPENAI_REASONING_EFFORT: "turbo" })?.reasoningEffort).toBe("low");
  });
});
