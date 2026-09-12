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
import { z } from "zod";
import type { MutationCategory } from "../helpers/register-tool.js";
import type { ToolDefinition } from "../types/tool-definition.js";
import type { ApprovalConfig } from "./approval-config.js";
import { sanitizeErrorMessage, writeAuditEvent, type AuditEvent, type AuditOutcome } from "./approval-audit.js";
import { approvalStore, type ApprovalStore, type ConsumeFailure } from "./approval-store.js";
import { buildApprovalMessage } from "./approval-summary.js";
import { canonicalJson, sha256Hex } from "./canonicalize.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

type DenialOutcome = Exclude<AuditOutcome, "requested" | "approved" | "executed" | "execution-failed">;

type Decision =
  | { approved: true; argsJson: string }
  | { approved: false; outcome: DenialOutcome; reason: string; error?: string };

type AuditContext = Pick<AuditEvent, "approvalId" | "toolName" | "category" | "payloadHash" | "realmId">;

const CONSUME_DENIAL: Record<ConsumeFailure, { outcome: DenialOutcome; reason: string }> = {
  expired: { outcome: "expired", reason: "the approval expired before it was used" },
  replayed: { outcome: "replayed", reason: "the approval was already used" },
  "tool-mismatch": { outcome: "hash-mismatch", reason: "the approval does not match this tool call" },
  "hash-mismatch": { outcome: "hash-mismatch", reason: "the approval does not match these arguments" },
  unknown: { outcome: "approval-error", reason: "the approval could not be found" },
};

const APPROVAL_SCHEMA: ElicitRequestFormParams["requestedSchema"] = {
  type: "object",
  properties: {
    approve: {
      type: "boolean",
      title: "Approve this exact QuickBooks mutation",
      description: "Set to true only if the summary above is exactly the change you want sent to QuickBooks.",
      default: false,
    },
  },
  required: ["approve"],
};

/**
 * Wraps a mutation handler so it runs at most once per call, and only after
 * the connected client's user explicitly approves the exact canonical payload.
 * Every failure before execution is a denial; none leads to execution.
 */
export function createApprovalHandler(
  server: McpServer,
  definition: ToolDefinition<z.ZodType<any, any>>,
  category: MutationCategory,
  config: ApprovalConfig,
  deps: { store?: ApprovalStore; now?: () => number } = {}
): ToolDefinition<z.ZodType<any, any>>["handler"] {
  const store = deps.store ?? approvalStore;
  const now = deps.now ?? Date.now;

  return async (args: unknown, extra: Extra): Promise<CallToolResult> => {
    const context: AuditContext = {
      approvalId: null,
      toolName: definition.name,
      category,
      payloadHash: null,
      realmId: null,
    };

    let decision: Decision;
    try {
      decision = await obtainApproval(server, context, config, store, now, args, extra);
    } catch (err) {
      decision = {
        approved: false,
        outcome: "approval-error",
        reason: "an internal approval error occurred",
        error: sanitizeErrorMessage(err),
      };
    }

    if (!decision.approved) return deny(config, context, decision);

    let result: CallToolResult;
    try {
      result = await definition.handler(JSON.parse(decision.argsJson), extra);
    } catch (err) {
      writeAuditOrReport(config, { ...context, outcome: "execution-failed", error: sanitizeErrorMessage(err) });
      throw err;
    }

    const failureText = executionFailureText(result);
    if (failureText === null) {
      writeAuditOrReport(config, { ...context, outcome: "executed", entityId: extractEntityId(result) });
    } else {
      writeAuditOrReport(config, { ...context, outcome: "execution-failed", error: sanitizeErrorMessage(failureText) });
    }
    return result;
  };
}

async function obtainApproval(
  server: McpServer,
  context: AuditContext,
  config: ApprovalConfig,
  store: ApprovalStore,
  now: () => number,
  args: unknown,
  extra: Extra
): Promise<Decision> {
  context.realmId = process.env.QUICKBOOKS_REALM_ID?.trim() || null;

  let argsJson: string;
  try {
    argsJson = canonicalJson(args);
    context.payloadHash = payloadHashOf(context, args);
  } catch (err) {
    return denial("approval-error", "the tool arguments could not be canonicalized", err);
  }

  if (!server.server.getClientCapabilities()?.elicitation?.form) {
    return denial(
      "unsupported-client",
      "the connected MCP client does not support elicitation, so approval-mode mutations cannot run"
    );
  }

  const record = store.issue({
    toolName: context.toolName,
    category: context.category,
    payloadHash: context.payloadHash,
    ttlMs: config.timeoutMs,
  });
  context.approvalId = record.id;

  try {
    writeAuditEvent(config.auditLogPath, { ...context, outcome: "requested" });
  } catch (err) {
    return denial("approval-error", "the approval audit log could not be written", err);
  }

  let response: ElicitResult;
  try {
    response = await server.server.elicitInput(
      {
        mode: "form",
        message: buildApprovalMessage({
          toolName: context.toolName,
          category: context.category,
          args: JSON.parse(argsJson),
          realmId: context.realmId,
          approvalId: record.id,
          payloadHash: context.payloadHash,
          expiresAt: record.expiresAt,
        }),
        requestedSchema: APPROVAL_SCHEMA,
      },
      {
        timeout: Math.max(1, record.expiresAt - now()),
        signal: extra.signal,
        relatedRequestId: extra.requestId,
      }
    );
  } catch (err) {
    // Checked before the timeout code: the SDK rejects aborted requests with
    // an McpError carrying ErrorCode.RequestTimeout as well.
    if (extra.signal.aborted) {
      return denial("canceled", "the tool call was canceled before approval completed", err);
    }
    if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
      return denial("expired", "no approval was received before it expired", err);
    }
    return denial("approval-error", "the approval request failed", err);
  }

  switch (response.action) {
    case "accept":
      if (response.content?.approve !== true) {
        return denial("declined", "the approval form was submitted without approving the mutation");
      }
      break;
    case "decline":
      return denial("declined", "the user declined the mutation");
    case "cancel":
      return denial("canceled", "the user canceled the approval request");
    default:
      return denial("approval-error", "the client returned an unrecognized approval response");
  }

  if (extra.signal.aborted) {
    return denial("canceled", "the tool call was canceled before execution");
  }

  const consumed = store.consume(record.id, context.toolName, payloadHashOf(context, JSON.parse(argsJson)));
  if (!consumed.ok) {
    const { outcome, reason } = CONSUME_DENIAL[consumed.reason];
    return denial(outcome, reason);
  }

  try {
    writeAuditEvent(config.auditLogPath, { ...context, outcome: "approved" });
  } catch (err) {
    return denial("approval-error", "the approval audit log could not be written", err);
  }

  return { approved: true, argsJson };
}

function payloadHashOf(context: AuditContext, args: unknown): string {
  return sha256Hex(
    canonicalJson({
      toolName: context.toolName,
      category: context.category,
      realmId: context.realmId,
      arguments: args,
    })
  );
}

function denial(outcome: DenialOutcome, reason: string, err?: unknown): Decision {
  return err === undefined
    ? { approved: false, outcome, reason }
    : { approved: false, outcome, reason, error: sanitizeErrorMessage(err) };
}

function deny(
  config: ApprovalConfig,
  context: AuditContext,
  decision: Extract<Decision, { approved: false }>
): CallToolResult {
  const event: AuditEvent = { ...context, outcome: decision.outcome };
  if (decision.error !== undefined) event.error = decision.error;
  writeAuditOrReport(config, event);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `QuickBooks mutation blocked (${decision.outcome}): ${decision.reason}. No request was sent to QuickBooks. Approval ID: ${context.approvalId ?? "n/a"}.`,
      },
    ],
  };
}

/** For audit writes whose failure must not change the call's result (denials, post-execution outcomes); reported on stderr instead. */
function writeAuditOrReport(config: ApprovalConfig, event: AuditEvent): void {
  try {
    writeAuditEvent(config.auditLogPath, event);
  } catch (err) {
    console.error(
      `QuickBooks approval audit write failed (${event.outcome}, approval ${event.approvalId ?? "n/a"}): ${sanitizeErrorMessage(err)}`
    );
  }
}

function executionFailureText(result: CallToolResult): string | null {
  const firstText = result.content.find((block) => block.type === "text");
  const text = firstText?.type === "text" ? firstText.text : "";
  if (text.startsWith("Error")) return text;
  return result.isError === true ? text || "Tool returned an error result" : null;
}

function extractEntityId(result: CallToolResult): string | undefined {
  for (const block of result.content) {
    if (block.type !== "text") continue;
    const parsed = parseObject(block.text);
    if (parsed === null) continue;
    const candidates = [parsed, ...Object.values(parsed)];
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue;
      const id = candidate.Id;
      if (typeof id === "string" || typeof id === "number") return String(id);
    }
  }
  return undefined;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
