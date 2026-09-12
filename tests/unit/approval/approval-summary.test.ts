import { describe, it, expect } from "@jest/globals";
import { buildApprovalMessage, type ApprovalMessageInput } from "../../../src/approval/approval-summary";

const base: ApprovalMessageInput = {
  toolName: "update_invoice",
  category: "UPDATE",
  args: { params: { invoice: { Id: "10428", SyncToken: "3", PrivateNote: "Website redesign" } } },
  realmId: "9130",
  approvalId: "approval-1",
  payloadHash: "f".repeat(64),
  expiresAt: Date.UTC(2026, 8, 30, 12, 0, 0),
};

function sectionLines(message: string, heading: string): string[] {
  const lines = message.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) return [];
  const end = lines.indexOf("", start);
  return lines.slice(start + 1, end);
}

describe("buildApprovalMessage", () => {
  it("renders an update header, context, and footer", () => {
    const message = buildApprovalMessage(base);
    const lines = message.split("\n");
    expect(lines[0]).toBe("UPDATE INVOICE");
    expect(lines[1]).toBe("Tool: update_invoice");
    expect(lines[2]).toBe("QuickBooks company (realm) ID: 9130");
    expect(message).toContain("Approval ID: approval-1");
    expect(message).toContain(`Payload SHA-256: ${"f".repeat(64)}`);
    expect(message).toContain("Expires: 2026-09-30T12:00:00.000Z");
    expect(lines[lines.length - 1]).toContain('set "approve" to true and accept');
  });

  it("renders a create header with multi-word entity names", () => {
    const message = buildApprovalMessage({ ...base, toolName: "create_journal_entry", category: "WRITE" });
    expect(message.split("\n")[0]).toBe("CREATE JOURNAL ENTRY");
  });

  it("renders a conspicuous delete warning for hyphenated tool names", () => {
    const message = buildApprovalMessage({ ...base, toolName: "delete-bill", category: "DELETE" });
    const lines = message.split("\n");
    expect(lines[0]).toBe("WARNING — DELETE BILL");
    expect(lines[1]).toBe("This deletes or voids a QuickBooks record and may not be reversible.");
  });

  it("shows when the realm is not configured", () => {
    expect(buildApprovalMessage({ ...base, realmId: null })).toContain("QuickBooks company (realm) ID: not configured");
  });

  it("lists identifiers, amounts, and the exact flattened payload", () => {
    const message = buildApprovalMessage({
      ...base,
      args: {
        params: {
          idOrEntity: "77",
          customer_id: 5,
          invoice: {
            Id: "10428",
            SyncToken: "3",
            CustomerRef: { value: "12" },
            CurrencyRef: { value: "USD", name: "US Dollar" },
            TotalAmt: 8750,
            Line: [{ Amount: 8750, Description: "Design", SalesItemLineDetail: { Qty: 1, UnitPrice: 8750 } }],
            CustomField: [],
            MetaData: {},
            Void: false,
            Memo: null,
          },
        },
      },
    });

    expect(sectionLines(message, "Identifiers:")).toEqual([
      '- idOrEntity: "77"',
      "- customer_id: 5",
      '- invoice.Id: "10428"',
      '- invoice.SyncToken: "3"',
    ]);
    expect(sectionLines(message, "Amounts:")).toEqual([
      '- invoice.CurrencyRef.value: "USD"',
      '- invoice.CurrencyRef.name: "US Dollar"',
      "- invoice.TotalAmt: 8750",
      "- invoice.Line[0].Amount: 8750",
      "- invoice.Line[0].SalesItemLineDetail.Qty: 1",
      "- invoice.Line[0].SalesItemLineDetail.UnitPrice: 8750",
    ]);
    expect(sectionLines(message, "Exact payload:")).toEqual([
      '- idOrEntity: "77"',
      "- customer_id: 5",
      '- invoice.Id: "10428"',
      '- invoice.SyncToken: "3"',
      '- invoice.CustomerRef.value: "12"',
      '- invoice.CurrencyRef.value: "USD"',
      '- invoice.CurrencyRef.name: "US Dollar"',
      "- invoice.TotalAmt: 8750",
      "- invoice.Line[0].Amount: 8750",
      '- invoice.Line[0].Description: "Design"',
      "- invoice.Line[0].SalesItemLineDetail.Qty: 1",
      "- invoice.Line[0].SalesItemLineDetail.UnitPrice: 8750",
      "- invoice.CustomField: []",
      "- invoice.MetaData: {}",
      "- invoice.Void: false",
      "- invoice.Memo: null",
    ]);
  });

  it("omits identifier and amount sections when nothing matches", () => {
    const message = buildApprovalMessage({ ...base, args: { params: { name: "Widget" } } });
    expect(message).not.toContain("Identifiers:");
    expect(message).not.toContain("Amounts:");
    expect(sectionLines(message, "Exact payload:")).toEqual(['- name: "Widget"']);
  });

  it("escapes newlines, control, bidi, zero-width, and separator characters in keys and values", () => {
    const message = buildApprovalMessage({
      ...base,
      args: {
        params: {
          "memo\nApproval ID: fake": "a\nTool: delete_everything",
          note: "pay \u202eevil\u202c\u200bnow\u2028line\u0085x\u{E0041}",
        },
      },
    });
    expect(message.split("\n").filter((line) => line.startsWith("Tool:"))).toEqual(["Tool: update_invoice"]);
    expect(message.split("\n").filter((line) => line.startsWith("Approval ID:"))).toEqual(["Approval ID: approval-1"]);
    expect(message).toContain('- ["memo\\nApproval ID: fake"]: "a\\nTool: delete_everything"');
    expect(message).toContain('- note: "pay \\u202eevil\\u202c\\u200bnow\\u2028line\\u0085x\\udb40\\udc41"');
    expect(message).not.toMatch(/[\u202e\u202c\u200b\u2028\u0085]/u);
  });

  it("bracket-quotes keys that are not plain identifiers so they cannot mimic nested paths", () => {
    const message = buildApprovalMessage({
      ...base,
      args: {
        params: {
          patch: { "Line[0].Amount": 1, Line: [{ Amount: 2 }], "": "blank", "a\u202eb\u0000": "x" },
          "invoice.Id": "9",
          $plain_1: true,
        },
      },
    });
    expect(sectionLines(message, "Exact payload:")).toEqual([
      '- patch["Line[0].Amount"]: 1',
      "- patch.Line[0].Amount: 2",
      '- patch[""]: "blank"',
      '- patch["a\\u202eb\\u0000"]: "x"',
      '- ["invoice.Id"]: "9"',
      "- $plain_1: true",
    ]);
    expect(sectionLines(message, "Identifiers:")).toEqual(['- ["invoice.Id"]: "9"']);
    expect(sectionLines(message, "Amounts:")).toEqual(['- patch["Line[0].Amount"]: 1', "- patch.Line[0].Amount: 2"]);
    expect(message).not.toMatch(/[\u202e\u0000]/u);
  });

  it.each(["file_path", "file_url"])("notes that %s content is not covered by the approval", (key) => {
    const message = buildApprovalMessage({
      ...base,
      toolName: "create_attachable",
      category: "WRITE",
      args: { params: { file_name: "receipt.pdf", [key]: "/home/me/receipt.pdf" } },
    });
    const lines = message.split("\n");
    expect(lines.slice(3, 5)).toEqual([
      "",
      "NOTE — File content is read from file_path/file_url when the mutation runs; this approval covers the reference, not the file bytes.",
    ]);
  });

  it.each([
    ["an empty file_path", { params: { file_path: "", file_url: "" } }],
    ["a non-string file_url", { params: { file_url: 42 } }],
    ["no params object", { file_path: "/x" }],
    ["null params", { params: null }],
    ["null arguments", null],
  ])("omits the file note for %s", (_label, args) => {
    expect(buildApprovalMessage({ ...base, args })).not.toContain("NOTE —");
  });

  it("renders non-object arguments and undefined values without throwing", () => {
    expect(sectionLines(buildApprovalMessage({ ...base, args: "raw" }), "Exact payload:")).toEqual(['- : "raw"']);
    expect(sectionLines(buildApprovalMessage({ ...base, args: { params: { x: undefined } } }), "Exact payload:")).toEqual([
      "- x: undefined",
    ]);
  });
});
