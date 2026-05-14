import { formatCliCommand } from "../../cli/command-format.js";
import { sanitizeForLog } from "../../terminal/ansi.js";
import { normalizeProviderId } from "../provider-id.js";

export type OAuthRefreshFailureReason =
  | "refresh_token_reused"
  | "refresh_token_expired"
  | "refresh_token_invalidated"
  | "invalid_grant"
  | "sign_in_again"
  | "invalid_refresh_token"
  | "revoked";

const OAUTH_REFRESH_FAILURE_PROVIDER_RE = /OAuth token refresh failed for ([^:]+):/i;
const SAFE_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function isOAuthRefreshFailureMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("oauth token refresh failed") ||
    lower.includes("access token could not be refreshed") ||
    lower.includes("authentication session could not be refreshed automatically")
  );
}

function extractOAuthRefreshFailureProvider(message: string): string | null {
  const provider = message.match(OAUTH_REFRESH_FAILURE_PROVIDER_RE)?.[1]?.trim();
  return provider && provider.length > 0 ? provider : null;
}

function sanitizeOAuthRefreshFailureProvider(provider: string | null | undefined): string | null {
  const sanitized = provider ? sanitizeForLog(provider).replaceAll("`", "").trim() : "";
  const normalized = normalizeProviderId(sanitized);
  return normalized && SAFE_PROVIDER_ID_RE.test(normalized) ? normalized : null;
}

export function classifyOAuthRefreshFailureReason(
  message: string,
): OAuthRefreshFailureReason | null {
  const lower = message.toLowerCase();
  if (
    lower.includes("refresh_token_reused") ||
    lower.includes("refresh token was already used") ||
    lower.includes("refresh token has already been used") ||
    lower.includes("already been used to generate a new access token")
  ) {
    return "refresh_token_reused";
  }
  if (lower.includes("refresh_token_expired") || lower.includes("refresh token has expired")) {
    return "refresh_token_expired";
  }
  if (lower.includes("refresh_token_invalidated")) {
    return "refresh_token_invalidated";
  }
  if (lower.includes("invalid_grant")) {
    return "invalid_grant";
  }
  if (lower.includes("invalid refresh token")) {
    return "invalid_refresh_token";
  }
  if (lower.includes("expired or revoked") || lower.includes("revoked")) {
    return "revoked";
  }
  if (lower.includes("signing in again") || lower.includes("sign in again")) {
    return "sign_in_again";
  }
  return null;
}

export function classifyOAuthRefreshFailure(message: string): {
  provider: string | null;
  reason: OAuthRefreshFailureReason | null;
} | null {
  if (!isOAuthRefreshFailureMessage(message)) {
    return null;
  }
  return {
    provider: sanitizeOAuthRefreshFailureProvider(extractOAuthRefreshFailureProvider(message)),
    reason: classifyOAuthRefreshFailureReason(message),
  };
}

export function formatOAuthRefreshFailureAccountLabel(provider: string | null | undefined): string {
  const safeProvider = sanitizeOAuthRefreshFailureProvider(provider);
  switch (safeProvider) {
    case "openai-codex":
      return "your OpenAI account for Codex";
    case "openai":
      return "your OpenAI account";
    case null:
      return "your model provider account";
    default:
      return `your ${safeProvider} account`;
  }
}

export function buildOAuthRefreshFailureLoginCommand(provider: string | null | undefined): string {
  const safeProvider = sanitizeOAuthRefreshFailureProvider(provider);
  return safeProvider
    ? formatCliCommand(`openclaw models auth login --provider ${safeProvider}`)
    : formatCliCommand("openclaw models auth login");
}
