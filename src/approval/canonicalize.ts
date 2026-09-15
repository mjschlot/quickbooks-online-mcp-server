import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted recursively, `undefined` object
 * properties omitted (as JSON transport would). Throws for any value that has
 * no faithful JSON form, so a hash never silently covers a lossy projection.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot canonicalize non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`Cannot canonicalize ${typeof value} at ${path}`);
  }

  if (Array.isArray(value)) {
    // Array.from turns holes into undefined, which serialize rejects.
    const items = Array.from(value, (item: unknown, index) =>
      serialize(item, `${path}[${index}]`)
    );
    return `[${items.join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Cannot canonicalize non-plain object at ${path}`);
  }

  const members = Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, member]) => `${JSON.stringify(key)}:${serialize(member, `${path}.${key}`)}`);
  return `{${members.join(",")}}`;
}
