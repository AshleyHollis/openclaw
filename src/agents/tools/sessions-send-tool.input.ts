import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stripFormattedReasoningMessage } from "../../shared/text/formatted-reasoning-message.js";
import { ToolInputError } from "../tool-input-error.js";
import { readToolStringParam } from "./common.js";

const SESSIONS_SEND_MESSAGE_ALIASES = ["SendMessage", "content", "text"] as const;

export function normalizeSessionsSendArguments(args: unknown): Record<string, unknown> {
  const params = isRecord(args) ? { ...args } : {};
  if (typeof params.message !== "string" || !params.message.trim()) {
    for (const alias of SESSIONS_SEND_MESSAGE_ALIASES) {
      const value = readToolStringParam(params, alias, { trim: false });
      if (value?.trim()) {
        params.message = stripFormattedReasoningMessage(value);
        break;
      }
    }
  }
  for (const alias of SESSIONS_SEND_MESSAGE_ALIASES) {
    delete params[alias];
  }
  return params;
}

export function readSessionsSendMessage(params: Record<string, unknown>): string {
  const message = readToolStringParam(params, "message", { required: true, trim: false });
  if (!message.trim()) {
    throw new ToolInputError("message required");
  }
  return message;
}

export function readSessionsSendMode(params: Record<string, unknown>) {
  const mode = readToolStringParam(params, "mode");
  if (
    mode !== undefined &&
    mode !== "notify" &&
    mode !== "steer" &&
    mode !== "followup" &&
    mode !== "resume"
  ) {
    throw new ToolInputError("mode must be notify, steer, followup, or resume");
  }
  return mode;
}
