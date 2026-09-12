import { describe, it, expect, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { mockQuickbooksClient, mockQuickbooksClientClass } from "../../mocks/quickbooks.mock";

// register-tool loads the approval wrapper, which imports the QuickBooks client.
jest.unstable_mockModule("../../../src/clients/quickbooks-client", () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { getCrudCategory } = await import("../../../src/helpers/register-tool");

// Tool files are read as text rather than imported: importing them would pull
// every handler into the coverage report without exercising it. The patterns
// below are strict, so a tool file that declares its definition differently
// fails the discovery test instead of being skipped.

const SRC_DIR = path.join(process.cwd(), "src");
const TOOLS_DIR = path.join(SRC_DIR, "tools");

interface DiscoveredTool {
  file: string;
  exportName: string;
  name: string;
}

const TOOL_NAME = /^const toolName = "([^"]+)";$/gm;
const DEFINITION_EXPORT = /^export const (\w+): ToolDefinition<[^>]*> = \{[^}]*\bname: toolName\b/gm;

const toolFiles = fs.readdirSync(TOOLS_DIR).filter((file) => file.endsWith(".ts")).sort();
const discovered: DiscoveredTool[] = [];
const undiscoverable: string[] = [];
for (const file of toolFiles) {
  const source = fs.readFileSync(path.join(TOOLS_DIR, file), "utf8");
  const names = Array.from(source.matchAll(TOOL_NAME), (match) => match[1]);
  const exports = Array.from(source.matchAll(DEFINITION_EXPORT), (match) => match[1]);
  if (names.length !== 1 || exports.length !== 1) {
    undiscoverable.push(`${file} (toolName: ${names.length}, ToolDefinition exports: ${exports.length})`);
    continue;
  }
  discovered.push({ file, exportName: exports[0], name: names[0] });
}

const EXPECTED_CATEGORY: Record<string, string> = {
  create: "WRITE",
  update: "UPDATE",
  delete: "DELETE",
  get: "READ",
  search: "READ",
  read: "READ",
};

describe("tool classification completeness", () => {
  it("discovers exactly one tool definition in every tool file", () => {
    expect(toolFiles.length).toBeGreaterThan(100);
    expect(toolFiles.filter((file) => !file.endsWith(".tool.ts"))).toEqual([]);
    expect(undiscoverable).toEqual([]);
  });

  it("classifies every tool by its verb prefix", () => {
    const mismatches = discovered.flatMap(({ file, name }) => {
      const verb = /^([a-z]+)[_-]/.exec(name)?.[1] ?? "";
      const category = getCrudCategory(name);
      return category === EXPECTED_CATEGORY[verb] ? [] : [`${file}: ${name} -> ${category}`];
    });
    expect(mismatches).toEqual([]);
  });

  it("has a unique name for every tool", () => {
    const names = discovered.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("registers every tool definition through RegisterTool in src/index.ts", () => {
    const source = fs
      .readFileSync(path.join(SRC_DIR, "index.ts"), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const registered = new Set(Array.from(source.matchAll(/RegisterTool\(\s*server\s*,\s*(\w+)\s*\)/g), (match) => match[1]));
    const unregistered = discovered
      .filter(({ exportName }) => !registered.has(exportName))
      .map(({ file, exportName }) => `${file}:${exportName}`);
    expect(unregistered).toEqual([]);
    expect(registered.size).toBe(discovered.length);
  });

  it("registers tools with the MCP server only inside RegisterTool", () => {
    const offenders = fs
      .readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && path.normalize(file) !== path.join("helpers", "register-tool.ts"))
      .filter((file) => /\.(tool|registerTool)\s*\(/.test(fs.readFileSync(path.join(SRC_DIR, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
