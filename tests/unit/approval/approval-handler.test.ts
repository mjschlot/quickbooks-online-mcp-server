import { describe, it, expect, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type ElicitRequestFormParams,
  type ElicitResult,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import { createApprovalHandler } from "../../../src/approval/approval-handler";
import type { ApprovalConfig } from "../../../src/approval/approval-config";
import { ApprovalStore } from "../../../src/approval/approval-store";
import type { ToolDefinition } from "../../../src/types/tool-definition";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ElicitFn = (params: ElicitRequestFormParams, options?: RequestOptions) => Promise<ElicitResult>;
type InnerFn = (args: unknown, extra: unknown) => Promise<CallToolResult>;

const FORM_CAPABILITIES = { elicitation: { form: {} } };
const ACCEPT: ElicitResult = { action: "accept", content: { approve: true } };
const SUCCESS: CallToolResult = {
  content: [
    { type: "text", text: "Invoice updated:" },
    { type: "text", text: JSON.stringify({ Id: "42", PrivateNote: "Website redesign" }) },
  ],
};

function invoiceArgs() {
  return { params: { invoice: { Id: "10428", SyncToken: "3", TotalAmt: 8750, PrivateNote: "Website redesign" } } };
}

function tempLog(): { dir: string; logPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbo-approval-"));
  return { dir, logPath: path.join(dir, "audit.jsonl") };
}

function readAudit(logPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

interface SetupOptions {
  capabilities?: unknown;
  auditLogPath?: string | null;
  timeoutMs?: number;
  store?: ApprovalStore;
  now?: () => number;
  inner?: InnerFn;
  toolName?: string;
  omitDeps?: boolean;
}

function setup(options: SetupOptions = {}) {
  const log = tempLog();
  const auditLogPath = options.auditLogPath === undefined ? log.logPath : options.auditLogPath;
  const getClientCapabilities = jest.fn(() =>
    "capabilities" in options ? options.capabilities : FORM_CAPABILITIES
  );
  const elicitInput = jest.fn<ElicitFn>().mockResolvedValue(ACCEPT);
  const server = { server: { getClientCapabilities, elicitInput } } as unknown as McpServer;
  const inner = jest.fn<InnerFn>(options.inner ?? (async () => SUCCESS));
  const definition: ToolDefinition<z.ZodType<any, any>> = {
    name: options.toolName ?? "update_invoice",
    description: "Update an invoice",
    schema: z.object({ invoice: z.any() }),
    handler: inner,
  };
  const config: ApprovalConfig = { timeoutMs: options.timeoutMs ?? 300_000, auditLogPath };
  const store = options.store ?? new ApprovalStore();
  const handler = options.omitDeps
    ? createApprovalHandler(server, definition, "UPDATE", config)
    : createApprovalHandler(server, definition, "UPDATE", config, { store, now: options.now });
  const controller = new AbortController();
  const extra = { signal: controller.signal, requestId: 7, sendNotification: jest.fn(), sendRequest: jest.fn() } as unknown as Extra;
  const call = async (args: Record<string, unknown> = invoiceArgs()) => handler(args, extra);
  return { call, inner, elicitInput, getClientCapabilities, controller, store, auditLogPath, dir: log.dir };
}

function outcomes(logPath: string | null): unknown[] {
  return logPath === null ? [] : readAudit(logPath).map((event) => event.outcome);
}

function blockedText(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  const [block] = result.content;
  return block.type === "text" ? block.text : "";
}

function approvalIdFrom(params: ElicitRequestFormParams): string {
  const match = /^Approval ID: (.+)$/m.exec(params.message);
  return match ? match[1] : "";
}

afterEach(() => {
  delete process.env.QUICKBOOKS_REALM_ID;
});

describe("createApprovalHandler before approval", () => {
  it("does not invoke the handler until the approval resolves", async () => {
    const ctx = setup();
    let resolveElicit: (value: ElicitResult) => void = () => undefined;
    ctx.elicitInput.mockImplementationOnce(() => new Promise((resolve) => { resolveElicit = resolve; }));

    const pending = ctx.call();
    await new Promise((resolve) => setImmediate(resolve));
    expect(ctx.elicitInput).toHaveBeenCalledTimes(1);
    expect(ctx.inner).not.toHaveBeenCalled();

    resolveElicit(ACCEPT);
    await pending;
    expect(ctx.inner).toHaveBeenCalledTimes(1);
    expect(ctx.elicitInput.mock.invocationCallOrder[0]).toBeLessThan(ctx.inner.mock.invocationCallOrder[0]);
  });

  it("requests a boolean form approval bound to the call", async () => {
    process.env.QUICKBOOKS_REALM_ID = " 9130 ";
    const ctx = setup({ timeoutMs: 120_000, store: new ApprovalStore(() => 1_000), now: () => 1_000 });
    await ctx.call();

    const [params, options] = ctx.elicitInput.mock.calls[0];
    expect(params.mode).toBe("form");
    expect(params.message).toContain("UPDATE INVOICE");
    expect(params.message).toContain("QuickBooks company (realm) ID: 9130");
    expect(params.message).toContain("- invoice.TotalAmt: 8750");
    expect(params.requestedSchema).toEqual({
      type: "object",
      properties: {
        approve: expect.objectContaining({ type: "boolean", title: "Approve this exact QuickBooks mutation", default: false }),
      },
      required: ["approve"],
    });
    expect(options).toEqual({ timeout: 120_000, signal: expect.any(AbortSignal), relatedRequestId: 7 });
  });

  it("never passes a non-positive timeout", async () => {
    const ctx = setup({ timeoutMs: 1_000, store: new ApprovalStore(() => 0), now: () => 5_000 });
    ctx.elicitInput.mockResolvedValueOnce({ action: "decline" });
    await ctx.call();
    expect(ctx.elicitInput.mock.calls[0][1]).toMatchObject({ timeout: 1 });
  });
});

describe("createApprovalHandler accepted approval", () => {
  it("executes exactly once with the approved arguments and audits the lifecycle", async () => {
    process.env.QUICKBOOKS_REALM_ID = "9130";
    const ctx = setup();
    const args = invoiceArgs();
    const result = await ctx.call(args);

    expect(result).toBe(SUCCESS);
    expect(ctx.inner).toHaveBeenCalledTimes(1);
    expect(ctx.inner.mock.calls[0][0]).toEqual(args);
    expect(ctx.inner.mock.calls[0][0]).not.toBe(args);

    const events = readAudit(ctx.auditLogPath as string);
    expect(events.map((event) => event.outcome)).toEqual(["requested", "approved", "executed"]);
    const approvalId = approvalIdFrom(ctx.elicitInput.mock.calls[0][0]);
    for (const event of events) {
      expect(event).toMatchObject({ approvalId, toolName: "update_invoice", category: "UPDATE", realmId: "9130" });
      expect(event.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(events[2].entityId).toBe("42");
  });

  it("keeps argument values out of the audit log", async () => {
    process.env.QUICKBOOKS_CLIENT_SECRET = "client-secret-value";
    try {
      const ctx = setup();
      await ctx.call();
      const raw = fs.readFileSync(ctx.auditLogPath as string, "utf8");
      expect(raw).not.toContain("Website redesign");
      expect(raw).not.toContain("8750");
      expect(raw).not.toContain("10428");
      expect(raw).not.toContain("client-secret-value");
    } finally {
      delete process.env.QUICKBOOKS_CLIENT_SECRET;
    }
  });

  it("uses the default store and clock when no dependencies are injected", async () => {
    const ctx = setup({ omitDeps: true, auditLogPath: null });
    await ctx.call();
    expect(ctx.inner).toHaveBeenCalledTimes(1);
  });

  it("executes the arguments as approved even if the original object is mutated during approval", async () => {
    const ctx = setup();
    const args = invoiceArgs();
    ctx.elicitInput.mockImplementationOnce(async () => {
      args.params.invoice.TotalAmt = 1;
      args.params.invoice.Id = "99999";
      return ACCEPT;
    });
    await ctx.call(args);
    expect(ctx.inner).toHaveBeenCalledTimes(1);
    expect(ctx.inner.mock.calls[0][0]).toEqual(invoiceArgs());
  });

  it("requires a new approval for every call, even with identical arguments", async () => {
    const ctx = setup();
    await ctx.call();
    ctx.elicitInput.mockResolvedValueOnce({ action: "decline" });
    const second = await ctx.call();

    expect(ctx.elicitInput).toHaveBeenCalledTimes(2);
    expect(ctx.inner).toHaveBeenCalledTimes(1);
    expect(blockedText(second)).toContain("(declined)");
    const [first, next] = ctx.elicitInput.mock.calls.map(([params]) => approvalIdFrom(params));
    expect(first).not.toBe(next);
  });
});

describe("createApprovalHandler denials", () => {
  it.each([
    ["accept with approve=false", { action: "accept", content: { approve: false } }, "declined"],
    ["accept without content", { action: "accept" }, "declined"],
    ["accept with a truthy non-boolean", { action: "accept", content: { approve: "true" } }, "declined"],
    ["decline", { action: "decline" }, "declined"],
    ["cancel", { action: "cancel" }, "canceled"],
    ["an unknown action", { action: "maybe" }, "approval-error"],
  ])("blocks on %s", async (_label, response, outcome) => {
    const ctx = setup();
    ctx.elicitInput.mockResolvedValueOnce(response as ElicitResult);
    const result = await ctx.call();

    expect(ctx.inner).not.toHaveBeenCalled();
    const text = blockedText(result);
    expect(text).toMatch(new RegExp(`^QuickBooks mutation blocked \\(${outcome}\\): .+\\. No request was sent to QuickBooks\\. Approval ID: [0-9a-f-]{36}\\.$`));
    expect(outcomes(ctx.auditLogPath)).toEqual(["requested", outcome]);
  });

  it.each([
    ["no capabilities", undefined],
    ["capabilities without elicitation", {}],
    ["elicitation without form support", { elicitation: { url: {} } }],
  ])("fails closed for a client with %s", async (_label, capabilities) => {
    const ctx = setup({ capabilities });
    const result = await ctx.call();

    expect(ctx.inner).not.toHaveBeenCalled();
    expect(ctx.elicitInput).not.toHaveBeenCalled();
    expect(blockedText(result)).toBe(
      "QuickBooks mutation blocked (unsupported-client): the connected MCP client does not support elicitation, so approval-mode mutations cannot run. No request was sent to QuickBooks. Approval ID: n/a."
    );
    const events = readAudit(ctx.auditLogPath as string);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "unsupported-client", approvalId: null });
    expect(events[0].payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("blocks with expired when the approval request times out", async () => {
    const ctx = setup();
    ctx.elicitInput.mockRejectedValueOnce(new McpError(ErrorCode.RequestTimeout, "Request timed out"));
    const result = await ctx.call();
    expect(ctx.inner).not.toHaveBeenCalled();
    expect(blockedText(result)).toContain("(expired)");
    expect(outcomes(ctx.auditLogPath)).toEqual(["requested", "expired"]);
  });

  it("blocks with canceled when the tool call is aborted during approval", async () => {
    const ctx = setup();
    ctx.elicitInput.mockImplementationOnce(async () => {
      ctx.controller.abort();
      throw new McpError(ErrorCode.RequestTimeout, "AbortError");
    });
    const result = await ctx.call();
    expect(ctx.inner).not.toHaveBeenCalled();
    expect(blockedText(result)).toContain("(canceled)");
  });

  it("blocks with canceled when the tool call is aborted after a positive approval", async () => {
    const ctx = setup();
    ctx.elicitInput.mockImplementationOnce(async () => {
      ctx.controller.abort();
      return ACCEPT;
    });
    const result = await ctx.call();
    expect(ctx.inner).not.toHaveBeenCalled();
    expect(blockedText(result)).toContain("(canceled)");
  });

  it.each([
    ["a generic error", new Error("Client does not support form elicitation.")],
    ["a non-timeout McpError", new McpError(ErrorCode.InvalidParams, "content does not match requested schema")],
  ])("blocks with approval-error when elicitation rejects with %s", async (_label, error) => {
    const ctx = setup();
    ctx.elicitInput.mockRejectedValueOnce(error);
    const result = await ctx.call();
    expect(ctx.inner).not.toHaveBeenCalled();
    expect(blockedText(result)).toContain("(approval-error): the approval request failed");
    const events = readAudit(ctx.auditLogPath as string);
    expect(events[1]).toMatchObject({ outcome: "approval-error", error: expect.any(String) });
  });

  it("blocks when the arguments cannot be canonicalized", async () => {
    const ctx = setup();
    const result = await ctx.call({ params: { invoice: { TotalAmt: Number.NaN } } });
    expect(ctx.inner).not.toHaveBeenCalled();
    expect(ctx.elicitInput).not.toHaveBeenCalled();
    expect(blockedText(result)).toContain("(approval-error): the tool arguments could not be canonicalized");
    expect(readAudit(ctx.auditLogPath as string)[0]).toMatchObject({ outcome: "approval-error", payloadHash: null, approvalId: null });
  });

  it("blocks on an unexpected internal error", async () => {
    const ctx = setup();
    ctx.getClientCapabilities.mockImplementationOnce(() => {
      throw new Error("state corrupted");
    });
    const result = await ctx.call();
    expect(ctx.inner).not.toHaveBeenCalled();
    expect(blockedText(result)).toContain("(approval-error): an internal approval error occurred");
    expect(readAudit(ctx.auditLogPath as string)[0]).toMatchObject({ outcome: "approval-error", error: "state corrupted" });
  });

  it.each([
    ["replayed", "replayed"],
    ["hash-mismatch", "hash-mismatch"],
    ["tool-mismatch", "hash-mismatch"],
    ["expired", "expired"],
    ["unknown", "approval-error"],
  ] as const)("blocks when the store rejects consumption as %s", async (reason, outcome) => {
    const store = new ApprovalStore();
    jest.spyOn(store, "consume").mockReturnValue({ ok: false, reason });
    const ctx = setup({ store });
    const result = await ctx.call();
    expect(ctx.inner).not.toHaveBeenCalled();
    expect(blockedText(result)).toContain(`(${outcome})`);
    expect(outcomes(ctx.auditLogPath)).toEqual(["requested", outcome]);
  });

  it("blocks a replayed approval that was consumed while the prompt was open", async () => {
    const store = new ApprovalStore();
    const ctx = setup({ store });
    ctx.elicitInput.mockImplementationOnce(async (params) => {
      store.consume(approvalIdFrom(params), "update_invoice", "whatever");
      return ACCEPT;
    });
    const result = await ctx.call();
    expect(ctx.inner).not.toHaveBeenCalled();
    expect(blockedText(result)).toContain("(replayed)");
  });

  it("blocks an approval that expires while the prompt is open", async () => {
    const clock = { now: 0 };
    const ctx = setup({ timeoutMs: 1_000, store: new ApprovalStore(() => clock.now), now: () => clock.now });
    ctx.elicitInput.mockImplementationOnce(async () => {
      clock.now = 1_001;
      return ACCEPT;
    });
    const result = await ctx.call();
    expect(ctx.inner).not.toHaveBeenCalled();
    expect(blockedText(result)).toContain("(expired)");
  });

  it("blocks without prompting when the requested audit event cannot be written", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = setup({ auditLogPath: path.join(os.tmpdir(), `qbo-missing-${Date.now()}`, "audit.jsonl") });
    const result = await ctx.call();
    expect(ctx.elicitInput).not.toHaveBeenCalled();
    expect(ctx.inner).not.toHaveBeenCalled();
    expect(blockedText(result)).toContain("(approval-error): the approval audit log could not be written");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("QuickBooks approval audit write failed (approval-error"));
  });

  it("reports a failed denial audit on stderr before an approval id exists", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = setup({ capabilities: {}, auditLogPath: path.join(os.tmpdir(), `qbo-missing-${Date.now()}`, "audit.jsonl") });
    const result = await ctx.call();
    expect(ctx.inner).not.toHaveBeenCalled();
    expect(blockedText(result)).toContain("(unsupported-client)");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("(unsupported-client, approval n/a)"));
  });

  it("blocks when the approved audit event cannot be written", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = setup();
    ctx.elicitInput.mockImplementationOnce(async () => {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
      return ACCEPT;
    });
    const result = await ctx.call();
    expect(ctx.inner).not.toHaveBeenCalled();
    expect(blockedText(result)).toContain("(approval-error): the approval audit log could not be written");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("createApprovalHandler execution outcomes", () => {
  it("audits a thrown handler error with a sanitized message and rethrows it", async () => {
    const failure = new Error("QuickBooks rejected Authorization: Bearer abc.def.ghi");
    const ctx = setup({ inner: async () => { throw failure; } });
    await expect(ctx.call()).rejects.toBe(failure);
    expect(ctx.inner).toHaveBeenCalledTimes(1);
    const events = readAudit(ctx.auditLogPath as string);
    expect(events.map((event) => event.outcome)).toEqual(["requested", "approved", "execution-failed"]);
    expect(events[2].error).toContain("[REDACTED]");
    expect(JSON.stringify(events)).not.toContain("abc.def.ghi");
  });

  it.each([
    ["an Error text result", { content: [{ type: "text", text: "Error updating invoice: stale SyncToken" }] }, "Error updating invoice: stale SyncToken"],
    ["isError with text", { isError: true, content: [{ type: "text", text: "Rejected" }] }, "Rejected"],
    ["isError without text", { isError: true, content: [] }, "Tool returned an error result"],
  ])("audits %s as execution-failed and returns it", async (_label, toolResult, error) => {
    const ctx = setup({ inner: async () => toolResult as CallToolResult });
    const result = await ctx.call();
    expect(result).toBe(toolResult);
    const events = readAudit(ctx.auditLogPath as string);
    expect(events[2]).toMatchObject({ outcome: "execution-failed", error });
    expect(events[2]).not.toHaveProperty("entityId");
  });

  it.each([
    ["a nested Id", [{ type: "text", text: "Created:" }, { type: "text", text: JSON.stringify({ Invoice: { Id: 42 } }) }], "42"],
    ["a later nested object", [{ type: "text", text: JSON.stringify({ time: 1, Bill: { Id: "7" } }) }], "7"],
    ["non-text blocks before the id", [{ type: "image", data: "", mimeType: "image/png" }, { type: "text", text: '{"Id":"5"}' }], "5"],
    ["no JSON", [{ type: "text", text: "Done" }], undefined],
    ["a JSON array", [{ type: "text", text: '[{"Id":"1"}]' }], undefined],
    ["an Id of the wrong type", [{ type: "text", text: '{"Id":true,"Nested":{"Id":null}}' }], undefined],
    ["no content", [], undefined],
  ])("extracts the entity id from %s", async (_label, content, entityId) => {
    const ctx = setup({ inner: async () => ({ content }) as CallToolResult });
    await ctx.call();
    const executed = readAudit(ctx.auditLogPath as string)[2];
    expect(executed.outcome).toBe("executed");
    expect(executed.entityId).toBe(entityId);
  });

  it("returns the result when the post-execution audit write fails", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    let ctx: ReturnType<typeof setup> | undefined;
    ctx = setup({
      inner: async () => {
        fs.rmSync((ctx as ReturnType<typeof setup>).dir, { recursive: true, force: true });
        return SUCCESS;
      },
    });
    const result = await ctx.call();
    expect(result).toBe(SUCCESS);
    expect(ctx.inner).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^QuickBooks approval audit write failed \(executed, approval [0-9a-f-]{36}\): /));
  });
});
