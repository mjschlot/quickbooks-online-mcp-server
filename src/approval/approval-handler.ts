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
import { QuickbooksClient } from "../clients/quickbooks-client.js";
import type { MutationCategory } from "../helpers/register-tool.js";
import type { PreparedApproval, ToolDefinition } from "../types/tool-definition.js";
import type { ApprovalConfig } from "./approval-config.js";
import {
  collectRedactableValues,
  sanitizeErrorMessage,
  writeAuditEvent,
  type AuditEvent,
  type AuditOutcome,
} from "./approval-audit.js";
import { approvalStore, type ApprovalStore, type ConsumeFailure } from "./approval-store.js";
import { buildApprovalMessage } from "./approval-summary.js";
import { canonicalJson, sha256Hex } from "./canonicalize.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

type AnyToolDefinition = ToolDefinition<z.ZodType<any, any>>;

type DenialOutcome = Exclude<AuditOutcome, "requested" | "approved" | "executed" | "execution-failed">;

/** `cause` becomes the audit `error`, sanitized with the call's argument values redacted. */
type Decision =
  | { approved: true; argsJson: string; prepared: PreparedApproval | null }
  | { approved: false; outcome: DenialOutcome; reason: string; cause?: unknown };

type AuditContext = Pick<AuditEvent, "approvalId" | "toolName" | "category" | "payloadHash" | "realmId">;

// The helper's message usually repeats the file_path or file_url, so only the
// client-facing denial text carries it.
const PIN_FAILURE_AUDIT_ERROR = "external input could not be pinned";

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

interface ApprovalDeps {
  store?: ApprovalStore;
  now?: () => number;
  /** The realm the handler's QuickBooks requests will target; may authenticate. */
  realmId?: () => Promise<string>;
}

interface CallEnvironment {
  server: McpServer;
  definition: AnyToolDefinition;
  config: ApprovalConfig;
  store: ApprovalStore;
  now: () => number;
  realmId: () => Promise<string>;
}

/**
 * Wraps a mutation handler so it runs at most once per call, and only after
 * the connected client's user explicitly approves the exact canonical payload,
 * the QuickBooks realm it will target, and any external inputs the tool pins.
 * Every failure before execution is a denial; none leads to execution.
 */
export function createApprovalHandler(
  server: McpServer,
  definition: AnyToolDefinition,
  category: MutationCategory,
  config: ApprovalConfig,
  deps: ApprovalDeps = {}
): AnyToolDefinition["handler"] {
  const env: CallEnvironment = {
    server,
    definition,
    config,
    store: deps.store ?? approvalStore,
    now: deps.now ?? Date.now,
    realmId: deps.realmId ?? QuickbooksClient.getRealmId,
  };

  return async (args: unknown, extra: Extra): Promise<CallToolResult> => {
    const context: AuditContext = {
      approvalId: null,
      toolName: definition.name,
      category,
      payloadHash: null,
      realmId: null,
    };
    return approveAndExecute(env, context, collectRedactableValues(args), args, extra);
  };
}

async function approveAndExecute(
  env: CallEnvironment,
  context: AuditContext,
  redactValues: readonly string[],
  args: unknown,
  extra: Extra
): Promise<CallToolResult> {
  const { config } = env;
  let decision: Decision;
  try {
    decision = await obtainApproval(env, context, args, extra);
  } catch (err) {
    decision = denial("approval-error", "an internal approval error occurred", err);
  }

  if (!decision.approved) return deny(config, context, redactValues, decision);

  const handler = decision.prepared?.handler ?? env.definition.handler;
  let result: CallToolResult;
  try {
    // Handlers may mutate their input, so they get a copy rather than the frozen approved value.
    result = await handler(JSON.parse(decision.argsJson), extra);
  } catch (err) {
    writeAuditOrReport(config, { ...context, outcome: "execution-failed", error: sanitizeErrorMessage(err, redactValues) });
    throw err;
  }

  const failureText = executionFailureText(result);
  if (failureText === null) {
    writeAuditOrReport(config, { ...context, outcome: "executed", entityId: extractEntityId(result) });
  } else {
    writeAuditOrReport(config, { ...context, outcome: "execution-failed", error: sanitizeErrorMessage(failureText, redactValues) });
  }
  return result;
}

async function obtainApproval(
  env: CallEnvironment,
  context: AuditContext,
  args: unknown,
  extra: Extra
): Promise<Decision> {
  const { server, definition, config, store, now } = env;

  let argsJson: string;
  try {
    argsJson = canonicalJson(args);
  } catch (err) {
    return denial("approval-error", "the tool arguments could not be canonicalized", err);
  }
  // One frozen copy shared by pinning, hashing, and the summary, so none of
  // them can change what the others see.
  const approvedArgs = deepFreeze(JSON.parse(argsJson));

  if (!server.server.getClientCapabilities()?.elicitation?.form) {
    return denial(
      "unsupported-client",
      "the connected MCP client does not support elicitation, so approval-mode mutations cannot run"
    );
  }

  try {
    context.realmId = await env.realmId();
  } catch (err) {
    return denial("approval-error", "the QuickBooks company (realm) ID could not be determined", err);
  }

  let prepared: PreparedApproval | null = null;
  if (definition.prepareApproval) {
    try {
      prepared = await definition.prepareApproval(approvedArgs, extra.signal);
    } catch (err) {
      if (extra.signal.aborted) {
        return denial("canceled", "the tool call was canceled while its external input was being pinned", err);
      }
      const reason = `the tool's external input could not be pinned for approval (${sanitizeErrorMessage(err)})`;
      return denial("approval-error", reason, PIN_FAILURE_AUDIT_ERROR);
    }
  }
  if (extra.signal.aborted) {
    return denial("canceled", "the tool call was canceled while its external input was being pinned");
  }
  const facts = prepared?.facts;

  try {
    context.payloadHash = payloadHashOf(context, approvedArgs, facts);
  } catch (err) {
    return denial("approval-error", "the pinned input facts could not be canonicalized", err);
  }

  // Issued only after the realm lookup and pinning, so authentication and
  // downloads do not consume the user's approval window.
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
          args: approvedArgs,
          realmId: context.realmId,
          pinned: facts,
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

  // Re-checked before consuming or auditing "approved": authentication during
  // the prompt (e.g. an interactive OAuth flow) can switch the company.
  let currentRealmId: string;
  try {
    currentRealmId = await env.realmId();
  } catch (err) {
    return denial("approval-error", "the QuickBooks company (realm) ID could not be re-checked before execution", err);
  }
  if (currentRealmId !== context.realmId) {
    return denial("hash-mismatch", "the QuickBooks company changed after approval");
  }

  if (extra.signal.aborted) {
    return denial("canceled", "the tool call was canceled before execution");
  }

  const consumed = store.consume(record.id, context.toolName, payloadHashOf(context, approvedArgs, facts));
  if (!consumed.ok) {
    const { outcome, reason } = CONSUME_DENIAL[consumed.reason];
    return denial(outcome, reason);
  }

  try {
    writeAuditEvent(config.auditLogPath, { ...context, outcome: "approved" });
  } catch (err) {
    return denial("approval-error", "the approval audit log could not be written", err);
  }

  return { approved: true, argsJson, prepared };
}

/** `pinned` is omitted from the hashed object when the tool has no prepare hook, so those hashes are unaffected. */
function payloadHashOf(context: AuditContext, args: unknown, pinned: PreparedApproval["facts"] | undefined): string {
  return sha256Hex(
    canonicalJson({
      toolName: context.toolName,
      category: context.category,
      realmId: context.realmId,
      arguments: args,
      ...(pinned === undefined ? {} : { pinned }),
    })
  );
}

function denial(outcome: DenialOutcome, reason: string, cause?: unknown): Extract<Decision, { approved: false }> {
  return cause === undefined ? { approved: false, outcome, reason } : { approved: false, outcome, reason, cause };
}

function deny(
  config: ApprovalConfig,
  context: AuditContext,
  redactValues: readonly string[],
  decision: Extract<Decision, { approved: false }>
): CallToolResult {
  const event: AuditEvent = { ...context, outcome: decision.outcome };
  if (decision.cause !== undefined) event.error = sanitizeErrorMessage(decision.cause, redactValues);
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

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
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
