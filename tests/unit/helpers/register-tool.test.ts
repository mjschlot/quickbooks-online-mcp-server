import { describe, it, expect, afterEach, jest } from "@jest/globals";
import {
  getCrudCategory,
  resolveMutationMode,
  RegisterTool,
} from "../../../src/helpers/register-tool";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDefinition } from "../../../src/types/tool-definition";

const POLICY_ENV = [
  "QUICKBOOKS_DISABLE_WRITE",
  "QUICKBOOKS_DISABLE_UPDATE",
  "QUICKBOOKS_DISABLE_DELETE",
  "QUICKBOOKS_WRITE_MODE",
  "QUICKBOOKS_UPDATE_MODE",
  "QUICKBOOKS_DELETE_MODE",
  "QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS",
  "QUICKBOOKS_APPROVAL_AUDIT_LOG",
  "QUICKBOOKS_APPROVAL_AUDIT_LOG_PATH",
];

function clearPolicyEnv() {
  for (const name of POLICY_ENV) delete process.env[name];
}

// ── getCrudCategory ──────────────────────────────────────────────────────────
// Uses literal expected values (not re-exported constants) so the test catches
// both a wrong mapping AND a wrong constant value simultaneously.
// Covers both underscore (standard) and hyphen (legacy) separator variants.

describe("getCrudCategory", () => {
  it("returns WRITE for create_ prefix",  () => expect(getCrudCategory("create_invoice")).toBe("WRITE"));
  it("returns WRITE for create- prefix",  () => expect(getCrudCategory("create-bill")).toBe("WRITE"));
  it("returns UPDATE for update_ prefix", () => expect(getCrudCategory("update_customer")).toBe("UPDATE"));
  it("returns UPDATE for update- prefix", () => expect(getCrudCategory("update-vendor")).toBe("UPDATE"));
  it("returns DELETE for delete_ prefix", () => expect(getCrudCategory("delete_payment")).toBe("DELETE"));
  it("returns DELETE for delete- prefix", () => expect(getCrudCategory("delete-bill")).toBe("DELETE"));
  it("returns READ for get_ prefix",      () => expect(getCrudCategory("get_invoice")).toBe("READ"));
  it("returns READ for get- prefix",      () => expect(getCrudCategory("get-vendor")).toBe("READ"));
  it("returns READ for search_ prefix",   () => expect(getCrudCategory("search_customers")).toBe("READ"));
  it("returns READ for search- prefix",   () => expect(getCrudCategory("search-customers")).toBe("READ"));
  it("returns READ for read_ prefix",     () => expect(getCrudCategory("read_invoice")).toBe("READ"));
  it("returns READ for read- prefix",     () => expect(getCrudCategory("read-invoice")).toBe("READ"));

  // Unknown verbs must fail closed instead of silently registering as READ.
  it.each(["void_invoice", "send_invoice", "list_accounts", "invoice", "Create_invoice"])(
    "throws for unrecognized name %j",
    (name) => expect(() => getCrudCategory(name)).toThrow(`Tool "${name}" has no recognized verb prefix`)
  );
});

// ── resolveMutationMode ──────────────────────────────────────────────────────

describe("resolveMutationMode", () => {
  afterEach(clearPolicyEnv);

  it.each(["WRITE", "UPDATE", "DELETE"] as const)("defaults %s to allow with no variables set", (category) =>
    expect(resolveMutationMode(category, {})).toBe("allow"));

  it.each([
    ["allow", "allow"],
    ["approval", "approval"],
    ["disabled", "disabled"],
    [" Approval ", "approval"],
    ["DISABLED", "disabled"],
  ] as const)("parses QUICKBOOKS_UPDATE_MODE=%j", (raw, expected) =>
    expect(resolveMutationMode("UPDATE", { QUICKBOOKS_UPDATE_MODE: raw })).toBe(expected));

  it("reads the variable for the requested category only", () => {
    const env = { QUICKBOOKS_WRITE_MODE: "approval", QUICKBOOKS_UPDATE_MODE: "disabled", QUICKBOOKS_DELETE_MODE: "allow" };
    expect(resolveMutationMode("WRITE", env)).toBe("approval");
    expect(resolveMutationMode("UPDATE", env)).toBe("disabled");
    expect(resolveMutationMode("DELETE", env)).toBe("allow");
  });

  it.each(["enabled", "true", "approve", "read-only"])("throws for invalid mode %j", (raw) => {
    expect(() => resolveMutationMode("DELETE", { QUICKBOOKS_DELETE_MODE: raw })).toThrow(
      `Invalid QUICKBOOKS_DELETE_MODE="${raw}"; expected one of: allow, approval, disabled.`
    );
  });

  // Legacy flags: only the exact string "true" disables a category.
  it.each([
    ["WRITE", "QUICKBOOKS_DISABLE_WRITE"],
    ["UPDATE", "QUICKBOOKS_DISABLE_UPDATE"],
    ["DELETE", "QUICKBOOKS_DISABLE_DELETE"],
  ] as const)("maps legacy %s disable=true to disabled", (category, legacy) =>
    expect(resolveMutationMode(category, { [legacy]: "true" })).toBe("disabled"));

  it.each(["false", "1", "TRUE", ""])('keeps allow when legacy flag is %j', (raw) =>
    expect(resolveMutationMode("WRITE", { QUICKBOOKS_DISABLE_WRITE: raw })).toBe("allow"));

  it("treats a blank mode variable as unset and falls back to the legacy flag", () =>
    expect(resolveMutationMode("WRITE", { QUICKBOOKS_WRITE_MODE: "  ", QUICKBOOKS_DISABLE_WRITE: "true" })).toBe("disabled"));

  it("lets an explicit mode win over the legacy flag in both directions", () => {
    expect(resolveMutationMode("WRITE", { QUICKBOOKS_DISABLE_WRITE: "true", QUICKBOOKS_WRITE_MODE: "allow" })).toBe("allow");
    expect(resolveMutationMode("WRITE", { QUICKBOOKS_DISABLE_WRITE: "true", QUICKBOOKS_WRITE_MODE: "approval" })).toBe("approval");
    expect(resolveMutationMode("WRITE", { QUICKBOOKS_DISABLE_WRITE: "false", QUICKBOOKS_WRITE_MODE: "disabled" })).toBe("disabled");
  });

  it("reads process.env by default", () => {
    process.env.QUICKBOOKS_DELETE_MODE = "approval";
    expect(resolveMutationMode("DELETE")).toBe("approval");
  });
});

// ── RegisterTool ─────────────────────────────────────────────────────────────
// Uses a minimal mock server object to avoid coupling to the MCP SDK internals.

describe("RegisterTool", () => {
  afterEach(clearPolicyEnv);

  const schema = z.object({ id: z.string() });
  const handler = jest.fn() as ToolDefinition<typeof schema>["handler"];
  const def = (name: string): ToolDefinition<typeof schema> =>
    ({ name, description: `desc:${name}`, schema, handler });
  const mockServer = () => ({ tool: jest.fn() });

  it("calls server.tool() with all definition fields for a READ tool", () => {
    const server = mockServer();
    const d = def("get_invoice");
    RegisterTool(server as unknown as McpServer, d);
    expect(server.tool).toHaveBeenCalledTimes(1);
    expect(server.tool).toHaveBeenCalledWith(d.name, d.description, { params: d.schema }, d.handler);
  });

  it.each([
    ["legacy flags", { QUICKBOOKS_DISABLE_WRITE: "true", QUICKBOOKS_DISABLE_UPDATE: "true", QUICKBOOKS_DISABLE_DELETE: "true" }],
    ["disabled modes", { QUICKBOOKS_WRITE_MODE: "disabled", QUICKBOOKS_UPDATE_MODE: "disabled", QUICKBOOKS_DELETE_MODE: "disabled" }],
    ["approval modes", { QUICKBOOKS_WRITE_MODE: "approval", QUICKBOOKS_UPDATE_MODE: "approval", QUICKBOOKS_DELETE_MODE: "approval" }],
  ])("registers READ tools with the original handler under %s", (_label, env) => {
    Object.assign(process.env, env);
    for (const name of ["search_invoices", "get-bill", "read_item"]) {
      const server = mockServer();
      RegisterTool(server as unknown as McpServer, def(name));
      expect(server.tool).toHaveBeenCalledWith(name, `desc:${name}`, { params: schema }, handler);
    }
  });

  describe.each([
    ["create_invoice", "create-bill", "QUICKBOOKS_WRITE_MODE", "QUICKBOOKS_DISABLE_WRITE"],
    ["update_customer", "update-vendor", "QUICKBOOKS_UPDATE_MODE", "QUICKBOOKS_DISABLE_UPDATE"],
    ["delete_payment", "delete-bill", "QUICKBOOKS_DELETE_MODE", "QUICKBOOKS_DISABLE_DELETE"],
  ])("%s / %s", (underscoreName, hyphenName, modeVar, legacyVar) => {
    it.each([underscoreName, hyphenName])("is absent when the mode is disabled (%s)", (name) => {
      process.env[modeVar] = "disabled";
      const server = mockServer();
      RegisterTool(server as unknown as McpServer, def(name));
      expect(server.tool).not.toHaveBeenCalled();
    });

    it.each([underscoreName, hyphenName])("is absent when the legacy flag is true (%s)", (name) => {
      process.env[legacyVar] = "true";
      const server = mockServer();
      RegisterTool(server as unknown as McpServer, def(name));
      expect(server.tool).not.toHaveBeenCalled();
    });

    it("registers the original handler when allowed by default", () => {
      const server = mockServer();
      RegisterTool(server as unknown as McpServer, def(underscoreName));
      expect(server.tool).toHaveBeenCalledWith(underscoreName, `desc:${underscoreName}`, { params: schema }, handler);
    });

    it("registers the original handler when mode=allow overrides the legacy flag", () => {
      process.env[legacyVar] = "true";
      process.env[modeVar] = "allow";
      const server = mockServer();
      RegisterTool(server as unknown as McpServer, def(underscoreName));
      expect(server.tool).toHaveBeenCalledWith(underscoreName, `desc:${underscoreName}`, { params: schema }, handler);
    });

    it("registers a wrapped handler when mode=approval", () => {
      process.env[modeVar] = "approval";
      const server = mockServer();
      RegisterTool(server as unknown as McpServer, def(underscoreName));
      expect(server.tool).toHaveBeenCalledTimes(1);
      const [name, description, shape, registered] = server.tool.mock.calls[0];
      expect([name, description, shape]).toEqual([underscoreName, `desc:${underscoreName}`, { params: schema }]);
      expect(typeof registered).toBe("function");
      expect(registered).not.toBe(handler);
    });
  });

  it("throws for a tool name with no recognized prefix", () => {
    const server = mockServer();
    expect(() => RegisterTool(server as unknown as McpServer, def("void_invoice"))).toThrow("no recognized verb prefix");
    expect(server.tool).not.toHaveBeenCalled();
  });

  it("throws for an invalid mode", () => {
    process.env.QUICKBOOKS_UPDATE_MODE = "sometimes";
    const server = mockServer();
    expect(() => RegisterTool(server as unknown as McpServer, def("update_customer"))).toThrow("QUICKBOOKS_UPDATE_MODE");
    expect(server.tool).not.toHaveBeenCalled();
  });

  it.each([
    ["an approval-mode mutation", "create_invoice", { QUICKBOOKS_WRITE_MODE: "approval" }],
    ["an allow-mode mutation", "create_invoice", {}],
    ["a disabled mutation", "delete_payment", { QUICKBOOKS_DELETE_MODE: "disabled" }],
    ["a READ tool", "get_invoice", {}],
  ])("throws for invalid approval configuration when registering %s", (_label, name, env) => {
    Object.assign(process.env, env, { QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS: "0" });
    const server = mockServer();
    expect(() => RegisterTool(server as unknown as McpServer, def(name))).toThrow("QUICKBOOKS_APPROVAL_TIMEOUT_SECONDS");
    expect(server.tool).not.toHaveBeenCalled();
  });

  it("throws for an audit log path without the audit log flag in allow mode", () => {
    process.env.QUICKBOOKS_APPROVAL_AUDIT_LOG_PATH = "/tmp/approvals.jsonl";
    const server = mockServer();
    expect(() => RegisterTool(server as unknown as McpServer, def("update_customer"))).toThrow("QUICKBOOKS_APPROVAL_AUDIT_LOG=true");
    expect(server.tool).not.toHaveBeenCalled();
  });
});
