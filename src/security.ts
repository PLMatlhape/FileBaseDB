const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]"],
  [/(access[_-]?token\s*[:=]\s*)([^\s,'"&]+)/gi, "$1[REDACTED]"],
  [/(refresh[_-]?token\s*[:=]\s*)([^\s,'"&]+)/gi, "$1[REDACTED]"],
  [/(client[_-]?secret\s*[:=]\s*)([^\s,'"&]+)/gi, "$1[REDACTED]"],
  [/(authorization\s*[:=]\s*)([^\s,'"&]+)/gi, "$1[REDACTED]"],
  [/([?&](?:access_token|refresh_token|client_secret|token)=)([^&\s]+)/gi, "$1[REDACTED]"],
];

export function redactSecrets(value: string): string {
  let redacted = value;

  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }

  if (redacted.length > 800) {
    redacted = `${redacted.slice(0, 800)}…`;
  }

  return redacted;
}

export function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return redactSecrets(error.message || fallback);
  }

  if (typeof error === "string") {
    return redactSecrets(error);
  }

  return fallback;
}
