import { describe, it, expect } from "@jest/globals";
import { loadApprovalConfig } from "../../../src/approval/approval-config";

describe("loadApprovalConfig timeout", () => {
  it("defaults to 300 seconds when unset or empty", () => {
    expect(loadApprovalConfig({}).timeoutMs).toBe(300_000);
    expect(loadApprovalConfig({ QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS: "  " }).timeoutMs).toBe(300_000);
  });

  it.each([
    ["1", 1_000],
    ["3600", 3_600_000],
    [" 45 ", 45_000],
  ])("accepts %j", (raw, expected) => {
    expect(loadApprovalConfig({ QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS: raw }).timeoutMs).toBe(expected);
  });

  it.each(["0", "3601", "-5", "1.5", "abc", "1e3", "10s"])("rejects %j", (raw) => {
    expect(() => loadApprovalConfig({ QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS: raw })).toThrow(
      "QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS"
    );
  });
});

describe("loadApprovalConfig audit log", () => {
  it.each([undefined, "", "false"])("is off for %j", (flag) => {
    expect(loadApprovalConfig({ QUICKBOOKS_APPROVAL_AUDIT_LOG: flag }).auditLogPath).toBeNull();
  });

  it("is on with an absolute path", () => {
    const config = loadApprovalConfig({
      QUICKBOOKS_APPROVAL_AUDIT_LOG: "true",
      QUICKBOOKS_APPROVAL_AUDIT_LOG_PATH: "/var/log/qbo-approvals.jsonl",
    });
    expect(config.auditLogPath).toBe("/var/log/qbo-approvals.jsonl");
  });

  it("requires a path when on", () => {
    expect(() => loadApprovalConfig({ QUICKBOOKS_APPROVAL_AUDIT_LOG: "true" })).toThrow(
      "QUICKBOOKS_APPROVAL_AUDIT_LOG_PATH"
    );
  });

  it("rejects a relative path", () => {
    expect(() =>
      loadApprovalConfig({
        QUICKBOOKS_APPROVAL_AUDIT_LOG: "true",
        QUICKBOOKS_APPROVAL_AUDIT_LOG_PATH: "logs/approvals.jsonl",
      })
    ).toThrow("absolute");
  });

  it.each(["TRUE", "yes", "1"])("rejects flag value %j", (flag) => {
    expect(() => loadApprovalConfig({ QUICKBOOKS_APPROVAL_AUDIT_LOG: flag })).toThrow(
      "Invalid QUICKBOOKS_APPROVAL_AUDIT_LOG"
    );
  });

  it.each([undefined, "false"])("rejects a path when the flag is %j", (flag) => {
    expect(() =>
      loadApprovalConfig({
        QUICKBOOKS_APPROVAL_AUDIT_LOG: flag,
        QUICKBOOKS_APPROVAL_AUDIT_LOG_PATH: "/tmp/approvals.jsonl",
      })
    ).toThrow("QUICKBOOKS_APPROVAL_AUDIT_LOG=true");
  });
});
