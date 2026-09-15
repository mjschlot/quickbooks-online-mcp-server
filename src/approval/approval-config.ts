import path from "node:path";
import { APPROVAL_ENV, normalizeApprovalValue } from "./policy-env.js";

export interface ApprovalConfig {
  readonly timeoutMs: number;
  readonly auditLogPath: string | null;
}

const { TIMEOUT: TIMEOUT_ENV, AUDIT_LOG: AUDIT_LOG_ENV, AUDIT_LOG_PATH: AUDIT_LOG_PATH_ENV } = APPROVAL_ENV;

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 3600;

export function loadApprovalConfig(env: NodeJS.ProcessEnv): ApprovalConfig {
  return {
    timeoutMs: parseTimeoutSeconds(normalizeApprovalValue(env[TIMEOUT_ENV])) * 1000,
    auditLogPath: parseAuditLogPath(
      normalizeApprovalValue(env[AUDIT_LOG_ENV]),
      normalizeApprovalValue(env[AUDIT_LOG_PATH_ENV])
    ),
  };
}

function parseTimeoutSeconds(raw: string): number {
  if (!raw) return DEFAULT_TIMEOUT_SECONDS;
  const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(seconds >= 1 && seconds <= MAX_TIMEOUT_SECONDS)) {
    throw new Error(
      `Invalid ${TIMEOUT_ENV}=${JSON.stringify(raw)}; expected a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}.`
    );
  }
  return seconds;
}

function parseAuditLogPath(flag: string, logPath: string): string | null {
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
