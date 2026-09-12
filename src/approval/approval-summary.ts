import type { MutationCategory } from "../helpers/register-tool.js";

export interface ApprovalMessageInput {
  toolName: string;
  category: MutationCategory;
  args: unknown;
  realmId: string | null;
  approvalId: string;
  payloadHash: string;
  expiresAt: number;
}

interface Leaf {
  path: string;
  keys: string[];
  value: unknown;
}

const VERB: Record<MutationCategory, string> = { WRITE: "CREATE", UPDATE: "UPDATE", DELETE: "DELETE" };
const IDENTIFIER_KEY = /(^|_)id$|Id$|^idOrEntity$|SyncToken/;
const AMOUNT_KEY = /amt|amount|total|balance|price|rate|qty|quantity/i;
// Line/paragraph separators and control/format characters (including bidi
// overrides and zero-width characters) could make a payload value render as
// extra summary lines, so they are shown as escapes instead.
const UNSAFE_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
// Keys outside this shape are bracket-quoted so a key such as "Line[0].Amount"
// cannot render like a genuine nested path.
const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const FILE_REFERENCE_KEYS = ["file_path", "file_url"];

export function buildApprovalMessage(input: ApprovalMessageInput): string {
  const entity = input.toolName
    .replace(/^(create|update|delete)[_-]/, "")
    .replace(/[_-]/g, " ")
    .toUpperCase();
  const leaves = flatten(input.args, "", []);
  const lines: string[] = [];

  if (input.category === "DELETE") {
    lines.push(`WARNING — DELETE ${entity}`);
    lines.push("This deletes or voids a QuickBooks record and may not be reversible.");
  } else {
    lines.push(`${VERB[input.category]} ${entity}`);
  }
  lines.push(`Tool: ${input.toolName}`);
  lines.push(`QuickBooks company (realm) ID: ${input.realmId ?? "not configured"}`);
  if (hasFileReference(input.args)) {
    lines.push("");
    lines.push(
      "NOTE — File content is read from file_path/file_url when the mutation runs; this approval covers the reference, not the file bytes."
    );
  }

  appendSection(lines, "Identifiers:", leaves.filter((leaf) => IDENTIFIER_KEY.test(lastKey(leaf))));
  appendSection(
    lines,
    "Amounts:",
    leaves.filter((leaf) => AMOUNT_KEY.test(lastKey(leaf)) || leaf.keys.includes("CurrencyRef"))
  );
  appendSection(lines, "Exact payload:", leaves);

  lines.push("");
  lines.push(`Approval ID: ${input.approvalId}`);
  lines.push(`Payload SHA-256: ${input.payloadHash}`);
  lines.push(`Expires: ${new Date(input.expiresAt).toISOString()}`);
  lines.push('To run this exact mutation, set "approve" to true and accept. Decline or cancel to block it.');
  return lines.join("\n");
}

function appendSection(lines: string[], heading: string, leaves: Leaf[]): void {
  if (leaves.length === 0) return;
  lines.push("", heading);
  for (const leaf of leaves) {
    lines.push(`- ${escapeUnsafe(displayPath(leaf.path))}: ${escapeUnsafe(renderValue(leaf.value))}`);
  }
}

function flatten(value: unknown, path: string, keys: string[]): Leaf[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ path, keys, value }];
    return value.flatMap((item: unknown, index) => flatten(item, `${path}[${index}]`, keys));
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [{ path, keys, value }];
    return entries.flatMap(([key, member]) =>
      flatten(member, `${path}${keySegment(key, path === "")}`, [...keys, key])
    );
  }
  return [{ path, keys, value }];
}

function keySegment(key: string, topLevel: boolean): string {
  if (!PLAIN_KEY.test(key)) return `[${JSON.stringify(key)}]`;
  return topLevel ? key : `.${key}`;
}

// The file-reading handler runs after approval, so the hash binds the reference
// string rather than the bytes it points to.
function hasFileReference(args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  const params: unknown = (args as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) return false;
  return FILE_REFERENCE_KEYS.some((key) => {
    const value: unknown = (params as Record<string, unknown>)[key];
    return typeof value === "string" && value.length > 0;
  });
}

function lastKey(leaf: Leaf): string {
  return leaf.keys[leaf.keys.length - 1] ?? "";
}

function displayPath(path: string): string {
  if (path.startsWith("params.")) return path.slice("params.".length);
  return path.startsWith("params[") ? path.slice("params".length) : path;
}

function renderValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function escapeUnsafe(text: string): string {
  return text.replace(UNSAFE_CHARACTER, (character) => {
    let escaped = "";
    for (let index = 0; index < character.length; index += 1) {
      escaped += `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`;
    }
    return escaped;
  });
}
