import path from "node:path";

export interface ApprovalConfig {
  readonly timeoutMs: number;
  readonly auditLogPath: string | null;
}

export const APPROVAL_ENV = {
  TIMEOUT: "QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS",
  AUDIT_LOG: "QUICKBOOKS_APPROVAL_AUDIT_LOG",
  AUDIT_LOG_PATH: "QUICKBOOKS_APPROVAL_AUDIT_LOG_PATH",
} as const;

const { TIMEOUT: TIMEOUT_ENV, AUDIT_LOG: AUDIT_LOG_ENV, AUDIT_LOG_PATH: AUDIT_LOG_PATH_ENV } = APPROVAL_ENV;

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 3600;

export function loadApprovalConfig(env: NodeJS.ProcessEnv): ApprovalConfig {
  return {
    timeoutMs: parseTimeoutSeconds(env[TIMEOUT_ENV]?.trim()) * 1000,
    auditLogPath: parseAuditLogPath(env[AUDIT_LOG_ENV]?.trim(), env[AUDIT_LOG_PATH_ENV]?.trim()),
  };
}

function parseTimeoutSeconds(raw: string | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_SECONDS;
  const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(seconds >= 1 && seconds <= MAX_TIMEOUT_SECONDS)) {
    throw new Error(
      `Invalid ${TIMEOUT_ENV}=${JSON.stringify(raw)}; expected a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}.`
    );
  }
  return seconds;
}

function parseAuditLogPath(flag: string | undefined, logPath: string | undefined): string | null {
  if (!flag || flag === "false") {
    if (logPath) {
      throw new Error(
        `${AUDIT_LOG_PATH_ENV} is set but approval audit logging is off; set ${AUDIT_LOG_ENV}=true to enable it or unset ${AUDIT_LOG_PATH_ENV}.`
      );
    }
    return null;
  }
  if (flag !== "true") {
    throw new Error(`Invalid ${AUDIT_LOG_ENV}=${JSON.stringify(flag)}; expected "true" or "false".`);
  }
  if (!logPath || !path.isAbsolute(logPath)) {
    throw new Error(`${AUDIT_LOG_ENV}=true requires ${AUDIT_LOG_PATH_ENV} to be an absolute file path.`);
  }
  return logPath;
}
