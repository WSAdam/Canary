export class CanaryError extends Error {
  constructor(
    public readonly fault: string,
    message: string,
    public readonly status: number = 500,
  ) {
    super(message);
    this.name = "CanaryError";
  }
}

/**
 * Optional upstream-response detail attached to errors thrown by HTTP sources
 * on a non-2xx response, so a failed run can persist what the endpoint actually
 * returned (status + body) rather than discarding it.
 */
export interface ResponseDetailCarrier {
  responseStatus?: number;
  responseBody?: string;
}

/**
 * Constant-time string comparison for secret/hash material. The length check
 * leaks length only, which is fine for fixed-length hex/base64 digests.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
