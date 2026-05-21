import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openAICompatibleEmbeddingProviderAdapter } from "./src/embedding-provider.js";

export default definePluginEntry({
  id: "openai-compatible-embeddings",
  name: "OpenAI-compatible Embeddings",
  description: "Generic embedding provider for OpenAI-compatible /v1/embeddings HTTP servers.",
  register(api: OpenClawPluginApi) {
    api.registerEmbeddingProvider(openAICompatibleEmbeddingProviderAdapter);
  },
});
