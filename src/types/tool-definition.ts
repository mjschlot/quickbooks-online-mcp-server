import { z } from "zod";
import { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * External inputs pinned before an approval prompt.
 * - `facts` describe those inputs; they are part of the approval payload hash and summary.
 * - `handler` runs instead of the tool's handler and must use only the pinned
 *   inputs plus the approved arguments it is given.
 * Pinned inputs are held by `handler` and must not need explicit release: the
 * wrapper drops a prepared approval, whatever the outcome, without cleanup.
 */
export interface PreparedApproval {
  facts: Record<string, string | number>;
  handler: ToolCallback<{ [key: string]: z.ZodType<any, any> }>;
}

export interface ToolDefinition<T extends z.ZodType<any, any>> {
  name: string;
  description: string;
  schema: T;
  handler: ToolCallback<{ [key: string]: T }>;
  /**
   * Used only by the approval wrapper; see PreparedApproval. `signal` is the
   * tool call's cancellation signal and should abort slow pinning work.
   */
  prepareApproval?(args: { params: z.infer<T> }, signal: AbortSignal): Promise<PreparedApproval>;
}
