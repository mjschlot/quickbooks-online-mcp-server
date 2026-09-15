import { describe, it, expect, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectRedactableValues,
  sanitizeErrorMessage,
  writeAuditEvent,
  type AuditEvent,
} from "../../../src/approval/approval-audit";

const SECRET_ENV = ["QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_REFRESH_TOKEN", "QUICKBOOKS_CLIENT_ID"];

const baseEvent: AuditEvent = {
  approvalId: "approval-1",
  toolName: "update_invoice",
  category: "UPDATE",
  payloadHash: "abc123",
  realmId: "9130",
  outcome: "requested",
};

function tempLogPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qbo-audit-")), "audit.jsonl");
}

describe("writeAuditEvent", () => {
  it("does nothing when the path is null", () => {
    expect(() => writeAuditEvent(null, baseEvent)).not.toThrow();
  });

  it("appends one JSON line per event with the documented fields", () => {
    const logPath = tempLogPath();
    writeAuditEvent(logPath, baseEvent);
    writeAuditEvent(logPath, { ...baseEvent, outcome: "executed", entityId: "42" });
    writeAuditEvent(logPath, { ...baseEvent, approvalId: null, payloadHash: null, realmId: null, outcome: "execution-failed", error: "boom" });

    const lines = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(Object.keys(lines[0])).toEqual(["timestamp", "approvalId", "toolName", "category", "payloadHash", "realmId", "outcome"]);
    expect(new Date(lines[0].timestamp).toISOString()).toBe(lines[0].timestamp);
    expect(lines[1]).toMatchObject({ outcome: "executed", entityId: "42" });
    expect(lines[1]).not.toHaveProperty("error");
    expect(lines[2]).toMatchObject({ approvalId: null, payloadHash: null, realmId: null, error: "boom" });
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it("never writes properties outside the audit schema", () => {
    const logPath = tempLogPath();
    const smuggled = { ...baseEvent, arguments: { params: { memo: "SENSITIVE-MEMO" } } };
    writeAuditEvent(logPath, smuggled);
    expect(fs.readFileSync(logPath, "utf8")).not.toContain("SENSITIVE-MEMO");
  });

  it("throws when the append fails", () => {
    const missingDir = path.join(os.tmpdir(), `qbo-audit-missing-${Date.now()}`, "nested", "audit.jsonl");
    expect(() => writeAuditEvent(missingDir, baseEvent)).toThrow();
  });
});

describe("collectRedactableValues", () => {
  it("collects distinct string leaves of at least 6 characters, longest first", () => {
    const args = {
      params: {
        memo: "Website redesign",
        currency: "USD",
        id: "10428",
        amount: 875000,
        lines: [{ description: "Design", note: "Website redesign" }, null, true],
      },
    };
    expect(collectRedactableValues(args)).toEqual(["Website redesign", "Design"]);
  });

  it("handles cyclic and non-object arguments", () => {
    const cyclic: Record<string, unknown> = { note: "cyclic value" };
    cyclic.self = cyclic;
    expect(collectRedactableValues(cyclic)).toEqual(["cyclic value"]);
    expect(collectRedactableValues("top-level")).toEqual(["top-level"]);
    expect(collectRedactableValues(undefined)).toEqual([]);
  });
});

describe("sanitizeErrorMessage", () => {
  afterEach(() => {
    for (const name of SECRET_ENV) delete process.env[name];
  });

  it("uses the message of Error values and never the stack", () => {
    const err = new Error("request failed");
    expect(sanitizeErrorMessage(err)).toBe("request failed");
  });

  it("accepts strings and summarizes other thrown values without dumping them", () => {
    expect(sanitizeErrorMessage("plain")).toBe("plain");
    expect(sanitizeErrorMessage({ access_token: "leak" })).toBe("Unknown error (object)");
  });

  it.each([
    ["Authorization: Bearer eyJhbGciOi.payload.sig", "eyJhbGciOi"],
    ["authorization=Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ['{"access_token":"at-123456","other":1}', "at-123456"],
    ["refresh_token=rt-abcdef&x=1", "rt-abcdef"],
    ["client_secret: cs-zzz", "cs-zzz"],
    ["id_token='idt-999'", "idt-999"],
    ['{\\"refresh_token\\":\\"escaped-rt\\"}', "escaped-rt"],
    ['"Authorization": "Token custom-scheme-value"', "custom-scheme-value"],
  ])("redacts credentials in %j", (message, secret) => {
    const sanitized = sanitizeErrorMessage(new Error(message));
    expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("[REDACTED]");
  });

  it("redacts current secret environment values of at least 8 characters", () => {
    process.env.QUICKBOOKS_CLIENT_SECRET = "super-secret-value";
    process.env.QUICKBOOKS_REFRESH_TOKEN = "refresh-token-value";
    process.env.QUICKBOOKS_CLIENT_ID = "short";
    const sanitized = sanitizeErrorMessage(
      new Error("secret super-secret-value token refresh-token-value id short")
    );
    expect(sanitized).toBe("secret [REDACTED] token [REDACTED] id short");
  });

  it("redacts exact occurrences of the given values, longest first", () => {
    const values = collectRedactableValues({ a: "redesign", b: "Website redesign" });
    expect(sanitizeErrorMessage(new Error("Website redesign and redesign"), values)).toBe("[REDACTED] and [REDACTED]");
  });

  it("ignores values longer than the message", () => {
    expect(sanitizeErrorMessage("short", ["short message that is longer"])).toBe("short");
  });

  it("redacts values before credential rules and truncation", () => {
    expect(sanitizeErrorMessage("rejected access_token=value-123456 now", ["access_token=value-123456"])).toBe(
      "rejected [REDACTED] now"
    );
    const sanitized = sanitizeErrorMessage(`${"x".repeat(489)} sensitive-note`, ["sensitive-note"]);
    expect(sanitized).toBe(`${"x".repeat(489)} [REDACTED]`);
  });

  it("truncates to 500 characters after redaction", () => {
    const sanitized = sanitizeErrorMessage(new Error(`${"x".repeat(495)} Bearer abcdefghijklmnop`));
    expect(sanitized).toHaveLength(500);
    expect(sanitized).not.toContain("abcdefgh");
  });
});
