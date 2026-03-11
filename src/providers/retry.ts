export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

/** Check if an error is transient (network failure, 429, 5xx). */
export function isTransient(err: unknown): boolean {
  if (err instanceof TransientError) return true;
  // Node fetch throws TypeError on network failures (DNS, connection reset, etc.)
  if (err instanceof TypeError && /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(err.message)) return true;
  // AggregateError from fetch can wrap connection errors
  if (err instanceof AggregateError) return err.errors.some(isTransient);
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with exponential backoff retry for transient failures.
 * Retries on network errors and 429/5xx responses.
 */
export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 15000));
    }
    try {
      const resp = await fetch(input, init);
      if ((resp.status === 429 || resp.status >= 500) && attempt < maxRetries) {
        lastError = new TransientError(`HTTP ${resp.status}`);
        continue;
      }
      return resp;
    } catch (err) {
      lastError = err;
      if (!isTransient(err) || attempt === maxRetries) throw err;
    }
  }
  throw lastError;
}
