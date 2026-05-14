import { describe, expect, it } from "vitest";
import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
  classifyOAuthRefreshFailureReason,
  formatOAuthRefreshFailureAccountLabel,
} from "./oauth-refresh-failure.js";

describe("classifyOAuthRefreshFailureReason", () => {
  it.each([
    ["OAuth token refresh failed for openai-codex: refresh_token_reused.", "refresh_token_reused"],
    [
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
      "refresh_token_reused",
    ],
    [
      "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
      "refresh_token_expired",
    ],
    [
      "OAuth token refresh failed for openai-codex: refresh_token_invalidated.",
      "refresh_token_invalidated",
    ],
    [
      "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
      "revoked",
    ],
    [
      "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
      "sign_in_again",
    ],
  ] as const)("classifies Codex refresh failure %s", (message, reason) => {
    expect(classifyOAuthRefreshFailureReason(message)).toBe(reason);
  });

  it("does not mark generic app-server account drift as terminal re-auth", () => {
    expect(
      classifyOAuthRefreshFailure(
        "Your access token could not be refreshed because the backend account state is temporarily inconsistent.",
      ),
    ).toEqual({ provider: null, reason: null });
  });

  it("ignores unrelated errors", () => {
    expect(classifyOAuthRefreshFailure("rate limit exceeded; try again later")).toBeNull();
  });
});

describe("buildOAuthRefreshFailureLoginCommand", () => {
  it("sanitizes provider ids in login guidance", () => {
    expect(buildOAuthRefreshFailureLoginCommand("openai-codex` --bad")).toBe(
      "openclaw models auth login",
    );
  });
});

describe("formatOAuthRefreshFailureAccountLabel", () => {
  it("uses everyday account wording for Codex OAuth", () => {
    expect(formatOAuthRefreshFailureAccountLabel("openai-codex")).toBe(
      "your OpenAI account for Codex",
    );
    expect(formatOAuthRefreshFailureAccountLabel(null)).toBe("your model provider account");
  });
});
