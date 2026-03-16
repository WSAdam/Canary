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
