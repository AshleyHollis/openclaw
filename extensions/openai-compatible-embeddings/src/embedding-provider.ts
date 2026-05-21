import type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/embedding-providers";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";

export const OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID = "openai-compatible";

export type OpenAICompatibleEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  dimensions?: number;
};

type OpenAICompatibleEmbeddingResponse = {
  data?: unknown;
};

function normalizeBaseUrl(value: string | undefined): string {
  const baseUrl = value?.trim();
  if (!baseUrl) {
    throw new Error(
      "openai-compatible embeddings: missing remote.baseUrl. Set it to your OpenAI-compatible embeddings server, for example http://127.0.0.1:11434/v1.",
    );
  }
  return baseUrl.replace(/\/+$/u, "");
}

function normalizeModel(value: string | undefined): string {
  const model = value?.trim();
  if (!model) {
    throw new Error(
      "openai-compatible embeddings: missing model. Set it to the embedding model id your server expects.",
    );
  }
  return model;
}

function normalizeDimensions(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("openai-compatible embeddings: dimensions must be a positive integer.");
  }
  return value;
}

function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

function buildHeaders(params: {
  apiKey: string | undefined;
  extra: Record<string, string> | undefined;
}): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  for (const [name, value] of Object.entries(params.extra ?? {})) {
    const normalizedName = normalizeHeaderName(name);
    if (!normalizedName || normalizedName === "authorization") {
      continue;
    }
    headers[normalizedName] = value;
  }
  if (params.apiKey) {
    headers.authorization = `Bearer ${params.apiKey}`;
  }
  return headers;
}

function isSensitiveHeaderName(name: string): boolean {
  return (
    name === "authorization" ||
    name === "proxy-authorization" ||
    name.includes("api-key") ||
    name.includes("token") ||
    name.includes("secret")
  );
}

function sanitizeCacheHeaders(headers: Record<string, string>): Record<string, string> | undefined {
  const safeHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !isSensitiveHeaderName(name)),
  );
  return Object.keys(safeHeaders).length > 0 ? safeHeaders : undefined;
}

function embeddingInputToText(input: EmbeddingInput): string {
  if (typeof input === "string") {
    return input;
  }
  if (!input.parts || input.parts.length === 0) {
    return input.text;
  }
  const textParts: string[] = [];
  for (const part of input.parts) {
    if (part.type !== "text") {
      throw new Error("openai-compatible embeddings only support text embedding inputs.");
    }
    textParts.push(part.text);
  }
  return textParts.join("");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function malformedEmbeddingResponse(): Error {
  return new Error("openai-compatible embeddings failed: malformed JSON response");
}

function readEmbeddingVector(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw malformedEmbeddingResponse();
  }
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw malformedEmbeddingResponse();
    }
  }
  return value;
}

function readEmbeddingVectors(
  payload: OpenAICompatibleEmbeddingResponse,
  expectedCount: number,
): number[][] {
  if (!Array.isArray(payload.data) || payload.data.length !== expectedCount) {
    throw malformedEmbeddingResponse();
  }
  return payload.data.map((entry) => {
    const record = asRecord(entry);
    if (!record) {
      throw malformedEmbeddingResponse();
    }
    return readEmbeddingVector(record.embedding);
  });
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new Error("openai-compatible embeddings failed: malformed JSON response", { cause });
  }
}

async function postEmbeddingRequest(params: {
  client: OpenAICompatibleEmbeddingClient;
  input: string[];
  signal?: AbortSignal;
}): Promise<number[][]> {
  const { client, input } = params;
  const body = {
    model: client.model,
    input,
    ...(typeof client.dimensions === "number" ? { dimensions: client.dimensions } : {}),
  };
  const { response, release } = await fetchWithSsrFGuard({
    url: `${client.baseUrl}/embeddings`,
    init: {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify(body),
    },
    signal: params.signal,
    policy: client.ssrfPolicy,
    auditContext: "embedding-provider:openai-compatible",
  });
  try {
    if (!response.ok) {
      throw new Error(
        `openai-compatible embeddings failed: HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return readEmbeddingVectors(
      (await readJsonResponse(response)) as OpenAICompatibleEmbeddingResponse,
      input.length,
    );
  } finally {
    await release();
  }
}

export function createOpenAICompatibleEmbeddingClient(
  options: EmbeddingProviderCreateOptions,
): OpenAICompatibleEmbeddingClient {
  const baseUrl = normalizeBaseUrl(options.remote?.baseUrl);
  const model = normalizeModel(options.model);
  const apiKey = normalizeResolvedSecretInputString({
    value: options.remote?.apiKey,
    path: "embeddingProviders.openai-compatible.remote.apiKey",
  })?.trim();
  return {
    baseUrl,
    headers: buildHeaders({ apiKey, extra: options.remote?.headers }),
    ssrfPolicy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    model,
    ...(options.dimensions !== undefined
      ? { dimensions: normalizeDimensions(options.dimensions) }
      : {}),
  };
}

export function createOpenAICompatibleEmbeddingProvider(options: EmbeddingProviderCreateOptions): {
  provider: EmbeddingProvider;
  client: OpenAICompatibleEmbeddingClient;
} {
  const client = createOpenAICompatibleEmbeddingClient(options);
  const embedBatch: EmbeddingProvider["embedBatch"] = async (inputs, callOptions) => {
    if (inputs.length === 0) {
      return [];
    }
    return await postEmbeddingRequest({
      client,
      input: inputs.map(embeddingInputToText),
      signal: callOptions?.signal,
    });
  };
  return {
    provider: {
      id: OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
      model: client.model,
      ...(typeof client.dimensions === "number" ? { dimensions: client.dimensions } : {}),
      embed: async (input, callOptions) => {
        const [embedding] = await embedBatch([input], callOptions);
        if (!embedding) {
          throw malformedEmbeddingResponse();
        }
        return embedding;
      },
      embedBatch,
    },
    client,
  };
}

export const openAICompatibleEmbeddingProviderAdapter: EmbeddingProviderAdapter = {
  id: OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
  transport: "remote",
  create: async (options) => {
    const { provider, client } = createOpenAICompatibleEmbeddingProvider(options);
    const cacheHeaders = sanitizeCacheHeaders(client.headers);
    return {
      provider,
      runtime: {
        id: OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
        inlineBatchTimeoutMs: 10 * 60_000,
        cacheKeyData: {
          provider: OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
          baseUrl: client.baseUrl,
          model: client.model,
          ...(typeof client.dimensions === "number" ? { dimensions: client.dimensions } : {}),
          ...(cacheHeaders ? { headers: cacheHeaders } : {}),
        },
      },
    };
  },
};
