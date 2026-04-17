import { safeErrorMessage } from "./security";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 4,
  baseDelayMs: 200,
  maxDelayMs: 3_000,
  jitterRatio: 0.2,
};

export function withRetryDefaults(options?: Partial<RetryOptions>): RetryOptions {
  return {
    ...DEFAULT_RETRY_OPTIONS,
    ...(options ?? {}),
  };
}

export async function runWithRetry<T>(
  task: () => Promise<T>,
  options: RetryOptions,
  shouldRetry: (error: unknown) => boolean
): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < options.maxAttempts) {
    attempt += 1;
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const retryable = shouldRetry(error);
      if (!retryable || attempt >= options.maxAttempts) {
        throw error;
      }

      const delayMs = computeDelay(attempt, options);
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(safeErrorMessage(lastError, "Retry failed with unknown error."));
}

export function isTransientProviderError(error: unknown): boolean {
  const message = safeErrorMessage(error, "").toLowerCase();
  if (!message) {
    return false;
  }

  return (
    /\b(429|500|502|503|504)\b/.test(message) ||
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("throttl") ||
    message.includes("temporar") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("network") ||
    message.includes("socket hang up")
  );
}

function computeDelay(attempt: number, options: RetryOptions): number {
  const exponential = options.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const bounded = Math.min(exponential, options.maxDelayMs);
  const jitterWindow = bounded * options.jitterRatio;
  const jitter = jitterWindow > 0 ? (Math.random() * 2 - 1) * jitterWindow : 0;
  return Math.max(0, Math.round(bounded + jitter));
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}