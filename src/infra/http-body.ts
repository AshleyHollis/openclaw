// Reads HTTP request and response bodies with timeout and byte limits.
import type { IncomingMessage, ServerResponse } from "node:http";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import { isUint8Array } from "node:util/types";
import {
  parseStrictNonNegativeInteger,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { formatErrorMessage } from "./errors.js";
import {
  isHttpConnectionClosing,
  selectHttpRequestRejection,
  sendHttpRequestRejection,
} from "./http-request-lifecycle.js";

export { readChunkWithIdleTimeout } from "./http-response-body-timeout.js";
export {
  cancelUnreadResponseBody,
  readResponseTextPrefix,
  readResponseWithLimit,
  readResponseTextSnippet,
  type ReadResponseTextPrefixOptions,
} from "./http-response-body.js";

export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_WEBHOOK_BODY_TIMEOUT_MS = 30_000;

export type RequestBodyLimitErrorCode =
  | "PAYLOAD_TOO_LARGE"
  | "REQUEST_BODY_TIMEOUT"
  | "CONNECTION_CLOSED";

type RequestBodyLimitErrorInit = {
  code: RequestBodyLimitErrorCode;
  message?: string;
};

const DEFAULT_ERROR_MESSAGE: Record<RequestBodyLimitErrorCode, string> = {
  PAYLOAD_TOO_LARGE: "PayloadTooLarge",
  REQUEST_BODY_TIMEOUT: "RequestBodyTimeout",
  CONNECTION_CLOSED: "RequestBodyConnectionClosed",
};

const DEFAULT_ERROR_STATUS_CODE: Record<RequestBodyLimitErrorCode, number> = {
  PAYLOAD_TOO_LARGE: 413,
  REQUEST_BODY_TIMEOUT: 408,
  CONNECTION_CLOSED: 400,
};

const DEFAULT_RESPONSE_MESSAGE: Record<RequestBodyLimitErrorCode, string> = {
  PAYLOAD_TOO_LARGE: "Payload too large",
  REQUEST_BODY_TIMEOUT: "Request body timeout",
  CONNECTION_CLOSED: "Connection closed",
};

export class RequestBodyLimitError extends Error {
  readonly code: RequestBodyLimitErrorCode;
  readonly statusCode: number;

  constructor(init: RequestBodyLimitErrorInit) {
    super(init.message ?? DEFAULT_ERROR_MESSAGE[init.code]);
    this.name = "RequestBodyLimitError";
    this.code = init.code;
    this.statusCode = DEFAULT_ERROR_STATUS_CODE[init.code];
  }
}

export function isRequestBodyLimitError(
  error: unknown,
  code?: RequestBodyLimitErrorCode,
): error is RequestBodyLimitError {
  if (!(error instanceof RequestBodyLimitError)) {
    return false;
  }
  if (!code) {
    return true;
  }
  return error.code === code;
}

export function requestBodyErrorToText(code: RequestBodyLimitErrorCode): string {
  return DEFAULT_RESPONSE_MESSAGE[code];
}

function parseContentLengthHeader(req: IncomingMessage): number | null {
  const header = req.headers["content-length"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = parseStrictNonNegativeInteger(raw);
  if (parsed !== undefined) {
    return parsed;
  }
  return /^\d+$/.test(raw.trim()) ? Number.MAX_SAFE_INTEGER : null;
}

export type ReadRequestBodyOptions = {
  maxBytes: number;
  timeoutMs?: number;
  encoding?: BufferEncoding;
  /** Pause instead of destroying on size/timeout failures so a caller can flush a response first. */
  destroyOnLimit?: boolean;
};

type RequestBodyLimitValues = {
  maxBytes: number;
  timeoutMs: number;
};

function resolveRequestBodyLimitValues(options: {
  maxBytes: number;
  timeoutMs?: number;
}): RequestBodyLimitValues {
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(1, Math.floor(options.maxBytes))
    : 1;
  const timeoutMs =
    options.timeoutMs === undefined
      ? DEFAULT_WEBHOOK_BODY_TIMEOUT_MS
      : resolveTimerTimeoutMs(options.timeoutMs, DEFAULT_WEBHOOK_BODY_TIMEOUT_MS);
  return { maxBytes, timeoutMs };
}

export const testApi = { resolveRequestBodyLimitValues };
export { testApi as __test__ };

function stopRequestBodyAfterLimit(req: IncomingMessage, destroyOnLimit: boolean): void {
  if (req.destroyed) {
    return;
  }
  if (destroyOnLimit) {
    // Limit violations are expected user input; destroying with an Error causes
    // an async 'error' event which can crash the process if no listener remains.
    req.destroy();
    return;
  }
  selectHttpRequestRejection(req);
}

export async function readRequestBodyWithLimit(
  req: IncomingMessage,
  options: ReadRequestBodyOptions,
): Promise<string> {
  const { maxBytes, timeoutMs } = resolveRequestBodyLimitValues(options);
  const encoding = options.encoding ?? "utf-8";
  const destroyOnLimit = options.destroyOnLimit !== false;

  if (isHttpConnectionClosing(req.socket)) {
    throw new RequestBodyLimitError({ code: "CONNECTION_CLOSED" });
  }

  const declaredLength = parseContentLengthHeader(req);
  if (declaredLength !== null && declaredLength > maxBytes) {
    const error = new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" });
    stopRequestBodyAfterLimit(req, destroyOnLimit);
    throw error;
  }

  return await new Promise((resolve, reject) => {
    let done = false;
    let totalBytes = 0;
    const chunks: Buffer[] = [];

    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("close", onClose);
      clearNodeTimeout(timer);
    };

    const finish = (cb: () => void) => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      cb();
    };

    const fail = (error: RequestBodyLimitError | Error) => {
      finish(() => reject(error));
    };

    const timer = setNodeTimeout(() => {
      const error = new RequestBodyLimitError({ code: "REQUEST_BODY_TIMEOUT" });
      stopRequestBodyAfterLimit(req, destroyOnLimit);
      fail(error);
    }, timeoutMs);

    const onData = (chunk: Buffer | string) => {
      if (done) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        const error = new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" });
        stopRequestBodyAfterLimit(req, destroyOnLimit);
        fail(error);
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      if (isHttpConnectionClosing(req.socket)) {
        fail(new RequestBodyLimitError({ code: "CONNECTION_CLOSED" }));
        return;
      }
      finish(() =>
        resolve(
          chunks.length === 1
            ? chunks[0]!.toString(encoding)
            : Buffer.concat(chunks).toString(encoding),
        ),
      );
    };

    const onError = (error: Error) => {
      if (done) {
        return;
      }
      fail(error);
    };

    const onClose = () => {
      fail(new RequestBodyLimitError({ code: "CONNECTION_CLOSED" }));
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
    if (req.destroyed && !req.readableEnded) {
      onClose();
    }
  });
}

export type ReadJsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; code: RequestBodyLimitErrorCode | "INVALID_JSON" };

export type ReadJsonBodyOptions = ReadRequestBodyOptions & {
  emptyObjectOnEmpty?: boolean;
};

export async function readJsonBodyWithLimit(
  req: IncomingMessage,
  options: ReadJsonBodyOptions,
): Promise<ReadJsonBodyResult> {
  try {
    const raw = await readRequestBodyWithLimit(req, options);
    const trimmed = raw.trim();
    if (!trimmed) {
      if (options.emptyObjectOnEmpty === false) {
        return { ok: false, code: "INVALID_JSON", error: "empty payload" };
      }
      return { ok: true, value: {} };
    }
    try {
      return { ok: true, value: JSON.parse(trimmed) as unknown };
    } catch (error) {
      return {
        ok: false,
        code: "INVALID_JSON",
        error: formatErrorMessage(error),
      };
    }
  } catch (error) {
    if (isRequestBodyLimitError(error)) {
      return { ok: false, code: error.code, error: requestBodyErrorToText(error.code) };
    }
    return {
      ok: false,
      code: "CONNECTION_CLOSED",
      error: requestBodyErrorToText("CONNECTION_CLOSED"),
    };
  }
}

export type RequestBodyLimitGuard = {
  dispose: () => void;
  isTripped: () => boolean;
  code: () => RequestBodyLimitErrorCode | null;
};

export type RequestBodyLimitGuardOptions = {
  maxBytes: number;
  timeoutMs?: number;
  /** Observe without consuming; close abandoned uploads when their response completes. */
  passive?: boolean;
  responseFormat?: "json" | "text";
  responseText?: Partial<Record<RequestBodyLimitErrorCode, string>>;
};

const requestBodyObservers = new WeakMap<IncomingMessage, Set<(bytes: number | null) => void>>();

// Observe ingress before decoding/consumption. A 'data' listener would start
// flowing and lose valid bytes while an authenticated handler awaits setup.
function observeRequestBodyBytes(req: IncomingMessage, observer: (bytes: number | null) => void) {
  let observers = requestBodyObservers.get(req);
  if (!observers) {
    observers = new Set();
    requestBodyObservers.set(req, observers);
    const current = observers;
    // Keep exact identity for restoration; invocation always supplies req as this.
    // oxlint-disable-next-line typescript/unbound-method
    const originalPush = req.push;
    const observedPush = (chunk: unknown, encoding?: BufferEncoding) => {
      const size =
        typeof chunk === "string"
          ? Buffer.byteLength(chunk, encoding)
          : isUint8Array(chunk)
            ? chunk.byteLength
            : 0;
      for (const observe of current) {
        observe(chunk === null ? null : size);
      }
      if (chunk === null) {
        restore();
      }
      return isHttpConnectionClosing(req.socket) ? false : originalPush.call(req, chunk, encoding);
    };
    req.push = observedPush;
    const restore = () => {
      req.off("end", restore);
      req.off("close", restore);
      if (req.push === observedPush) {
        req.push = originalPush;
      }
      requestBodyObservers.delete(req);
    };
    req.once("end", restore);
    req.once("close", restore);
  }
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

export function installRequestBodyLimitGuard(
  req: IncomingMessage,
  res: ServerResponse,
  options: RequestBodyLimitGuardOptions,
): RequestBodyLimitGuard {
  const { maxBytes: normalizedMaxBytes, timeoutMs } = resolveRequestBodyLimitValues(options);
  // A declared bodyless route must reject even one byte, not round its cap up.
  const maxBytes = options.maxBytes === 0 ? 0 : normalizedMaxBytes;
  const responseFormat = options.responseFormat ?? "json";
  const customText = options.responseText ?? {};

  let tripped = false;
  let reason: RequestBodyLimitErrorCode | null = null;
  let done = false;
  let totalBytes = 0;
  let removeBodyObserver: (() => void) | undefined;

  const cleanup = () => {
    removeBodyObserver?.();
    req.removeListener("data", onData);
    if (options.passive) {
      res.off("finish", onResponseComplete);
      res.off("close", onResponseComplete);
    }
    req.removeListener("end", finish);
    req.removeListener("close", finish);
    req.removeListener("error", finish);
    clearNodeTimeout(timer);
  };

  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    cleanup();
  };

  const respond = (error: RequestBodyLimitError) => {
    const text = customText[error.code] ?? requestBodyErrorToText(error.code);
    const body = responseFormat === "text" ? text : JSON.stringify({ error: text });
    const contentType = responseFormat === "text" ? "text/plain" : "application/json";
    void sendHttpRequestRejection(
      req,
      res,
      error.statusCode,
      body,
      `${contentType}; charset=utf-8`,
    );
  };

  const trip = (error: RequestBodyLimitError) => {
    if (tripped) {
      return;
    }
    tripped = true;
    reason = error.code;
    finish();
    respond(error);
  };

  const onBytes = (bytes: number | null) => {
    if (done) {
      return;
    }
    if (bytes === null) {
      finish();
      return;
    }
    totalBytes += bytes;
    if (totalBytes > maxBytes) {
      trip(new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" }));
    }
  };

  const onData = (chunk: Buffer | string) => {
    onBytes(typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length);
  };

  const onResponseComplete = () => {
    if (done) {
      return;
    }
    // Node discards unread ingress after an early response. Retire its
    // connection instead of silently admitting an unbounded upload/pipeline.
    if (!req.complete) {
      trip(new RequestBodyLimitError({ code: "CONNECTION_CLOSED" }));
    } else {
      finish();
    }
  };

  const timer = setNodeTimeout(() => {
    trip(new RequestBodyLimitError({ code: "REQUEST_BODY_TIMEOUT" }));
  }, timeoutMs);

  req.on("end", finish);
  req.on("close", finish);
  req.on("error", finish);

  const declaredLength = parseContentLengthHeader(req);
  if (isHttpConnectionClosing(req.socket)) {
    tripped = true;
    reason = "CONNECTION_CLOSED";
    finish();
  } else if (req.destroyed && !req.readableEnded) {
    finish();
  } else if (declaredLength !== null && declaredLength > maxBytes) {
    trip(new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" }));
  } else if (options.passive) {
    // Authentication can await while Node buffers the first body batch.
    onBytes(req.readableLength);
    if (req.complete) {
      finish();
    }
    if (!done) {
      removeBodyObserver = observeRequestBodyBytes(req, onBytes);
      res.prependOnceListener("finish", onResponseComplete);
      res.once("close", onResponseComplete);
      if (res.writableFinished || res.destroyed) {
        onResponseComplete();
      }
    }
  } else {
    // Preserve the SDK guard's established auto-consuming behavior.
    req.on("data", onData);
    if (req.readableEnded) {
      finish();
    }
  }

  return {
    dispose: finish,
    isTripped: () => tripped,
    code: () => reason,
  };
}
