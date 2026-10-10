export class UnsupportedOperationError extends Error {
  readonly operation: string;

  constructor(provider: string, operation: string) {
    super(`${provider} does not support ${operation}`);
    this.name = "UnsupportedOperationError";
    this.operation = operation;
  }
}

/**
 * A non-success HTTP response from the platform. The body is not retained, because an error body may echo request headers.
 */
export class PlatformRequestError extends Error {
  readonly status: number;

  readonly url: string;

  constructor(status: number, url: string) {
    super(`request to ${url} failed with status ${String(status)}`);
    this.name = "PlatformRequestError";
    this.status = status;
    this.url = url;
  }
}
