// Mutation-policy variable names and their value normalization. Kept free of
// imports so the QuickBooks client can check the token store against the host
// environment without loading tool registration or the approval wrapper.

export type PolicyValueNormalizer = (raw: string | undefined) => string;

export const MODE_ENV = {
  WRITE: "QUICKBOOKS_WRITE_MODE",
  UPDATE: "QUICKBOOKS_UPDATE_MODE",
  DELETE: "QUICKBOOKS_DELETE_MODE",
} as const;

export const APPROVAL_ENV = {
  TIMEOUT: "QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS",
  AUDIT_LOG: "QUICKBOOKS_APPROVAL_AUDIT_LOG",
  AUDIT_LOG_PATH: "QUICKBOOKS_APPROVAL_AUDIT_LOG_PATH",
} as const;

/** Mode values are case-insensitive; unset and blank both normalize to "". */
export const normalizeModeValue: PolicyValueNormalizer = (raw) => raw?.trim().toLowerCase() ?? "";

/** Approval values are case-sensitive (paths, "true"/"false"); unset and blank both normalize to "". */
export const normalizeApprovalValue: PolicyValueNormalizer = (raw) => raw?.trim() ?? "";

/** Values that normalize equal are interpreted identically by the mode resolver and approval config loader. */
export const POLICY_ENV_NORMALIZERS: ReadonlyArray<readonly [string, PolicyValueNormalizer]> = [
  ...Object.values(MODE_ENV).map((key) => [key, normalizeModeValue] as const),
  ...Object.values(APPROVAL_ENV).map((key) => [key, normalizeApprovalValue] as const),
];
