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
