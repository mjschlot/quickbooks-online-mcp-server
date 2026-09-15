import fs from "node:fs";
import type { MutationCategory } from "../helpers/register-tool.js";

export type AuditOutcome =
  | "requested"
  | "approved"
  | "declined"
  | "canceled"
  | "expired"
  | "unsupported-client"
  | "approval-error"
  | "replayed"
  | "hash-mismatch"
  | "executed"
  | "execution-failed";

export interface AuditEvent {
  approvalId: string | null;
  toolName: string;
  category: MutationCategory;
  payloadHash: string | null;
  realmId: string | null;
  outcome: AuditOutcome;
  entityId?: string;
  error?: string;
}

/**
 * Appends one JSON line. Fields are copied explicitly so tool arguments can
 * never reach the log through an extra property. Throws when the write fails;
 * the caller decides whether that blocks the mutation.
 */
export function writeAuditEvent(logPath: string | null, event: AuditEvent): void {
  if (logPath === null) return;
  const record = {
    timestamp: new Date().toISOString(),
    approvalId: event.approvalId,
    toolName: event.toolName,
    category: event.category,
    payloadHash: event.payloadHash,
    realmId: event.realmId,
    outcome: event.outcome,
    ...(event.entityId === undefined ? {} : { entityId: event.entityId }),
    ...(event.error === undefined ? {} : { error: event.error }),
  };
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

const REDACTED = "[REDACTED]";
const MAX_ERROR_LENGTH = 500;
const MIN_SECRET_LENGTH = 8;
// Shorter argument values (currency codes, small IDs and amounts) would mask
// ordinary words and numbers throughout the message.
const MIN_REDACTED_VALUE_LENGTH = 6;
const SECRET_ENV_NAMES = ["QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_REFRESH_TOKEN", "QUICKBOOKS_CLIENT_ID"];

// Bearer/Basic runs first so an "Authorization: Bearer x" header is fully
// covered before the key/value rules see it.
const REDACTION_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [/(access_token|refresh_token|client_secret|id_token)(\\?["']?\s*[:=]\s*\\?["']?)[^\s"'\\&,;}]+/gi, `$1$2${REDACTED}`],
  [/(authorization)(\\?["']?\s*[:=]\s*\\?["']?)[^\r\n"'\\&,;}]+/gi, `$1$2${REDACTED}`],
];

/**
 * String leaves of tool arguments to pass to sanitizeErrorMessage, longest
 * first so a value is redacted before any shorter value it contains. Iterative
 * and cycle-safe because it may run on arguments that cannot be canonicalized.
 */
export function collectRedactableValues(args: unknown): string[] {
  const values = new Set<string>();
  const seen = new Set<object>();
  const pending: unknown[] = [args];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.length >= MIN_REDACTED_VALUE_LENGTH) values.add(value);
    } else if (typeof value === "object" && value !== null && !seen.has(value)) {
      seen.add(value);
      for (const member of Object.values(value)) pending.push(member);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * Error message text only (never stacks or object dumps), truncated after
 * redacting credentials and exact occurrences of `redactValues` (from
 * collectRedactableValues). Value redaction is best effort: text QuickBooks
 * derives from a value without repeating it verbatim is not detected.
 */
export function sanitizeErrorMessage(err: unknown, redactValues: readonly string[] = []): string {
  let text = err instanceof Error ? err.message : typeof err === "string" ? err : `Unknown error (${typeof err})`;
  // Before the credential rules, which could rewrite part of a value and
  // prevent its exact match. Values longer than the text cannot occur in it.
  for (const value of redactValues) {
    if (value.length <= text.length) text = text.split(value).join(REDACTED);
  }
  for (const name of SECRET_ENV_NAMES) {
    const secret = process.env[name];
    if (secret && secret.length >= MIN_SECRET_LENGTH) text = text.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of REDACTION_RULES) {
    text = text.replace(pattern, replacement);
  }
  return text.slice(0, MAX_ERROR_LENGTH);
}
