import { describe, it, expect } from "@jest/globals";
import {
  POLICY_ENV_NORMALIZERS,
  normalizeApprovalValue,
  normalizeModeValue,
} from "../../../src/approval/policy-env";

describe("policy env normalization", () => {
  it("normalizes mode values case-insensitively", () => {
    expect(normalizeModeValue(" Approval ")).toBe("approval");
    expect(normalizeModeValue("   ")).toBe("");
    expect(normalizeModeValue(undefined)).toBe("");
  });

  it("trims approval values without changing case", () => {
    expect(normalizeApprovalValue(" /Logs/Audit.jsonl ")).toBe("/Logs/Audit.jsonl");
    expect(normalizeApprovalValue(undefined)).toBe("");
  });

  it("assigns a normalizer to each policy variable", () => {
    const kinds = POLICY_ENV_NORMALIZERS.map(([key, normalize]) => [
      key,
      normalize === normalizeModeValue ? "mode" : normalize === normalizeApprovalValue ? "approval" : "other",
    ]);
    expect(kinds).toEqual([
      ["QUICKBOOKS_WRITE_MODE", "mode"],
      ["QUICKBOOKS_UPDATE_MODE", "mode"],
      ["QUICKBOOKS_DELETE_MODE", "mode"],
      ["QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS", "approval"],
      ["QUICKBOOKS_APPROVAL_AUDIT_LOG", "approval"],
      ["QUICKBOOKS_APPROVAL_AUDIT_LOG_PATH", "approval"],
    ]);
  });
});
