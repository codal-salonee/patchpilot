import { stripVTControlCharacters } from "node:util";

export function redact(text: string, secrets: readonly string[] = []): string {
  let result = stripVTControlCharacters(text);
  for (const secret of secrets
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g,
      "[REDACTED TOKEN]",
    )
    .replace(
      /(\b(?:authorization\s*[:=]\s*(?:bearer|basic)?\s*|(?:api[_-]?key|password|secret|token)\s*[:=]\s*)["']?)[^\s"',;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@");
}

export function diagnostic(
  error: unknown,
  secrets: readonly string[] = [],
): string {
  return redact(
    error instanceof Error ? error.message : String(error),
    secrets,
  ).slice(-12_000);
}

export function quoted(text: string): string {
  return text
    .replaceAll("@", "(at)")
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
