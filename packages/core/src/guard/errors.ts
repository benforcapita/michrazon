export class DeniedSourceError extends Error {
  constructor(public readonly host: string) {
    super(`source host is denylisted: ${host}`);
    this.name = 'DeniedSourceError';
  }
}

export class NotAllowlistedError extends Error {
  constructor(public readonly host: string) {
    super(`source host is not on the allowlist: ${host}`);
    this.name = 'NotAllowlistedError';
  }
}

export class InsecureSchemeError extends Error {
  constructor(public readonly scheme: string) {
    super(`only https: URLs are allowed, got ${scheme}`);
    this.name = 'InsecureSchemeError';
  }
}

export class DocumentFetchForbiddenError extends Error {
  constructor(public readonly url: string) {
    super(`document/attachment fetches are forbidden: ${url}`);
    this.name = 'DocumentFetchForbiddenError';
  }
}

export class ForbiddenContentTypeError extends Error {
  constructor(public readonly contentType: string | null) {
    super(`response content-type is forbidden for this source: ${contentType ?? 'none'}`);
    this.name = 'ForbiddenContentTypeError';
  }
}

/** The source returned 403/blocked — stop it for the run, never bypass. */
export class SourceBlockedError extends Error {
  constructor(public readonly sourceId: string) {
    super(`source is blocked for this run (403): ${sourceId}`);
    this.name = 'SourceBlockedError';
  }
}

export class RateLimitExceededError extends Error {
  constructor(public readonly host: string) {
    super(`max requests per run reached for host: ${host}`);
    this.name = 'RateLimitExceededError';
  }
}
