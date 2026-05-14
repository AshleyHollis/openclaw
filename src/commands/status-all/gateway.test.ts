import { describe, expect, it } from "vitest";
import { summarizeLogTail } from "./gateway.js";

describe("summarizeLogTail", () => {
  it("marks permanent OAuth refresh failures as sign-in attention", () => {
    const lines = summarizeLogTail([
      "[openai-codex] Token refresh failed: 401 {",
      '"error":{"code":"invalid_grant","message":"Session invalidated due to signing in again"}',
      "}",
    ]);

    expect(lines).toEqual([
      "[openai-codex] token refresh 401 invalid_grant · OpenAI sign-in needs attention",
    ]);
  });
});
