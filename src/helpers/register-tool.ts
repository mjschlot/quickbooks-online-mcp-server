import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";
import { loadApprovalConfig } from "../approval/approval-config.js";
import { createApprovalHandler } from "../approval/approval-handler.js";

/**
 * Defines CRUD categories for tools
 */
export const CRUD_CATEGORY = {
  WRITE:  "WRITE",
  UPDATE: "UPDATE",
  DELETE: "DELETE",
  READ:   "READ",
} as const;

export type CrudCategory = typeof CRUD_CATEGORY[keyof typeof CRUD_CATEGORY];

export type MutationCategory = Exclude<CrudCategory, typeof CRUD_CATEGORY.READ>;

export type MutationMode = "allow" | "approval" | "disabled";

const MUTATION_MODES: readonly MutationMode[] = ["allow", "approval", "disabled"];

/**
 * Maps each CRUD category to its corresponding environment variable for disabling tools.
 * Consulted only when the category's MODE_ENV variable is unset.
 */
export const DISABLE_ENV = {
  [CRUD_CATEGORY.WRITE]:  "QUICKBOOKS_DISABLE_WRITE",
  [CRUD_CATEGORY.UPDATE]: "QUICKBOOKS_DISABLE_UPDATE",
  [CRUD_CATEGORY.DELETE]: "QUICKBOOKS_DISABLE_DELETE",
} as const;

export const MODE_ENV = {
  [CRUD_CATEGORY.WRITE]:  "QUICKBOOKS_WRITE_MODE",
  [CRUD_CATEGORY.UPDATE]: "QUICKBOOKS_UPDATE_MODE",
  [CRUD_CATEGORY.DELETE]: "QUICKBOOKS_DELETE_MODE",
} as const;

/**
 * Maps every verb prefix to its category. Handles both underscore
 * and legacy hyphen separator variants (e.g. create-bill, update-vendor).
 * All prefixes are distinct so order does not affect correctness.
 */
export const PREFIX_CATEGORY_MAP: Record<string, CrudCategory> = {
  "create_": CRUD_CATEGORY.WRITE,
  "create-": CRUD_CATEGORY.WRITE,
  "update_": CRUD_CATEGORY.UPDATE,
  "update-": CRUD_CATEGORY.UPDATE,
  "delete_": CRUD_CATEGORY.DELETE,
  "delete-": CRUD_CATEGORY.DELETE,
  "get_":    CRUD_CATEGORY.READ,
  "get-":    CRUD_CATEGORY.READ,
  "search_": CRUD_CATEGORY.READ,
  "search-": CRUD_CATEGORY.READ,
  "read_":   CRUD_CATEGORY.READ,
  "read-":   CRUD_CATEGORY.READ,
};

/**
 * Determines the CRUD category of a tool based on its name prefix.
 * Throws for an unrecognized prefix so a new mutating tool cannot bypass
 * mutation policy by being treated as READ.
 */
export function getCrudCategory(toolName: string): CrudCategory {
  for (const [prefix, category] of Object.entries(PREFIX_CATEGORY_MAP)) {
    if (toolName.startsWith(prefix)) return category;
  }
  throw new Error(
    `Tool "${toolName}" has no recognized verb prefix (${Object.keys(PREFIX_CATEGORY_MAP).join(", ")}); cannot classify it for mutation policy.`
  );
}

/**
 * A set, valid MODE_ENV value wins; an invalid one throws. When unset, the
 * legacy DISABLE_ENV flag disables the category only for the exact string "true".
 */
export function resolveMutationMode(
  category: MutationCategory,
  env: NodeJS.ProcessEnv = process.env
): MutationMode {
  const variable = MODE_ENV[category];
  const raw = env[variable]?.trim().toLowerCase();
  if (raw) {
    const mode = MUTATION_MODES.find((candidate) => candidate === raw);
    if (mode === undefined) {
      throw new Error(
        `Invalid ${variable}=${JSON.stringify(env[variable])}; expected one of: ${MUTATION_MODES.join(", ")}.`
      );
    }
    return mode;
  }
  return env[DISABLE_ENV[category]] === "true" ? "disabled" : "allow";
}

/**
 * Registers a tool according to its category's mutation mode: READ tools and
 * "allow" mutations register the original handler, "approval" mutations
 * register a handler gated on human approval, and "disabled" mutations are
 * not registered. Approval settings are validated on every call so a
 * misconfiguration fails at startup regardless of the modes in effect.
 */
export function RegisterTool<T extends z.ZodType<any, any>>(
  server: McpServer,
  toolDefinition: ToolDefinition<T>
) {
  const definition: ToolDefinition<z.ZodType<any, any>> = toolDefinition;
  const approvalConfig = loadApprovalConfig(process.env);
  const category = getCrudCategory(definition.name);
  let handler = definition.handler;
  if (category !== CRUD_CATEGORY.READ) {
    const mode = resolveMutationMode(category);
    if (mode === "disabled") return;
    if (mode === "approval") {
      handler = createApprovalHandler(server, definition, category, approvalConfig);
    }
  }
  server.tool(definition.name, definition.description, { params: definition.schema }, handler);
}
