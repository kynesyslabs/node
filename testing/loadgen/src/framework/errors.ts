export type LoadgenErrorCode =
  | "RPC_TIMEOUT"
  | "RPC_ERROR"
  | "NETWORK_ERROR"
  | "HTTP_ERROR"
  | "VALIDATION"
  | "CONVERGENCE"
  | "SETUP"
  | "RATE_LIMIT"
  | "CONFIRM"
  | "BROADCAST"
  | "UNKNOWN"

export class LoadgenError extends Error {
  readonly code: LoadgenErrorCode
  readonly context?: Record<string, unknown>
  readonly retryable: boolean

  constructor(
    message: string,
    code: LoadgenErrorCode,
    context?: Record<string, unknown>,
    retryable = false,
  ) {
    super(message)
    this.name = "LoadgenError"
    this.code = code
    this.context = context
    this.retryable = retryable
  }
}

export class RpcTimeoutError extends LoadgenError {
  constructor(url: string, operation: string, timeoutMs: number) {
    super(
      `RPC timeout: ${operation} at ${url} after ${timeoutMs}ms`,
      "RPC_TIMEOUT",
      { url, operation, timeoutMs },
      true,
    )
    this.name = "RpcTimeoutError"
  }
}

export class RpcRequestError extends LoadgenError {
  constructor(message: string, context?: Record<string, unknown>, retryable = true) {
    super(message, "RPC_ERROR", context, retryable)
    this.name = "RpcRequestError"
  }
}

export class NetworkError extends LoadgenError {
  constructor(message: string, context?: Record<string, unknown>, retryable = true) {
    super(message, "NETWORK_ERROR", context, retryable)
    this.name = "NetworkError"
  }
}

export class HttpStatusError extends LoadgenError {
  constructor(url: string, status: number, body?: unknown) {
    super(`HTTP error ${status} at ${url}`, "HTTP_ERROR", { url, status, body }, status >= 500 || status === 429)
    this.name = "HttpStatusError"
  }
}

export class ValidationError extends LoadgenError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "VALIDATION", context, false)
    this.name = "ValidationError"
  }
}

export class ConvergenceError extends LoadgenError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "CONVERGENCE", context, true)
    this.name = "ConvergenceError"
  }
}

export class SetupError extends LoadgenError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "SETUP", context, false)
    this.name = "SetupError"
  }
}

export class RateLimitError extends LoadgenError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "RATE_LIMIT", context, true)
    this.name = "RateLimitError"
  }
}

export class ConfirmError extends LoadgenError {
  constructor(message: string, context?: Record<string, unknown>, retryable = false) {
    super(message, "CONFIRM", context, retryable)
    this.name = "ConfirmError"
  }
}

export class BroadcastError extends LoadgenError {
  constructor(message: string, context?: Record<string, unknown>, retryable = false) {
    super(message, "BROADCAST", context, retryable)
    this.name = "BroadcastError"
  }
}

export type LoadgenErrorInfo = {
  code: LoadgenErrorCode
  message: string
  retryable: boolean
  context?: Record<string, unknown>
}

export function normalizeLoadgenError(error: unknown): LoadgenErrorInfo {
  if (error instanceof LoadgenError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      context: error.context,
    }
  }

  if (error instanceof Error) {
    return {
      code: "UNKNOWN",
      message: error.message,
      retryable: false,
    }
  }

  return {
    code: "UNKNOWN",
    message: String(error),
    retryable: false,
  }
}

export function serializeLoadgenError(error: unknown): Record<string, unknown> {
  const info = normalizeLoadgenError(error)
  return {
    code: info.code,
    message: info.message,
    retryable: info.retryable,
    context: info.context ?? null,
  }
}

export function loadgenErrorFromMessage(
  message: string,
  context?: Record<string, unknown>,
): LoadgenError {
  const lowered = message.toLowerCase()
  if (lowered.includes("rate limit") || lowered.includes("ip blocked")) return new RateLimitError(message, context)
  if (lowered.includes("signer does not match sender") || lowered.includes("transaction not applied")) {
    return new ValidationError(message, context)
  }
  if (lowered.includes("confirm failed")) return new ConfirmError(message, context)
  if (lowered.includes("broadcast failed")) return new BroadcastError(message, context)
  return new LoadgenError(message, "UNKNOWN", context, false)
}
