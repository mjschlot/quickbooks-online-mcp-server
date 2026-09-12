import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  type CallToolResult,
  type ClientCapabilities,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolDefinition } from "../../../src/types/tool-definition";
import { mockQuickbooksClient, mockQuickbooksClientClass } from "../../mocks/quickbooks.mock";

jest.unstable_mockModule("../../../src/clients/quickbooks-client", () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const { RegisterTool } = await import("../../../src/helpers/register-tool");

type InnerFn = (args: unknown, extra: unknown) => Promise<CallToolResult>;

const widgetSchema = z.object({ widget: z.object({ Id: z.string(), Name: z.string() }) });

function widgetTool(name: string, handler: InnerFn): ToolDefinition<typeof widgetSchema> {
  return { name, description: `${name} tool`, schema: widgetSchema, handler };
}

const widgetArgs = { params: { widget: { Id: "1", Name: "Renamed" } } };

describe("approval over a real MCP client/server connection", () => {
  let server: McpServer;
  let client: Client;
  const updateHandler = jest.fn<InnerFn>(async () => ({ content: [{ type: "text", text: '{"Id":"1"}' }] }));
  const readHandler = jest.fn<InnerFn>(async () => ({ content: [{ type: "text", text: "widget" }] }));
  const deleteHandler = jest.fn<InnerFn>(async () => ({ content: [{ type: "text", text: "deleted" }] }));

  beforeEach(() => {
    process.env.QUICKBOOKS_UPDATE_MODE = "approval";
    process.env.QUICKBOOKS_DELETE_MODE = "disabled";
    mockQuickbooksClientClass.getRealmId.mockResolvedValue("9130");
  });

  afterEach(async () => {
    delete process.env.QUICKBOOKS_UPDATE_MODE;
    delete process.env.QUICKBOOKS_DELETE_MODE;
    await client.close();
    await server.close();
  });

  async function connect(capabilities: ClientCapabilities, onElicit?: () => ElicitResult) {
    server = new McpServer({ name: "approval-e2e", version: "1.0.0" }, { capabilities: { tools: {} } });
    RegisterTool(server, widgetTool("update_widget", updateHandler));
    RegisterTool(server, widgetTool("get_widget", readHandler));
    RegisterTool(server, widgetTool("delete_widget", deleteHandler));

    client = new Client({ name: "approval-e2e-client", version: "1.0.0" }, { capabilities });
    const messages: string[] = [];
    if (onElicit) {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        messages.push(request.params.message);
        return onElicit();
      });
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return messages;
  }

  async function callTool(name: string) {
    return CallToolResultSchema.parse(await client.callTool({ name, arguments: widgetArgs }));
  }

  it("runs the mutation once after the client approves", async () => {
    const messages = await connect({ elicitation: {} }, () => ({ action: "accept", content: { approve: true } }));
    const result = await callTool("update_widget");

    expect(result.isError).toBeUndefined();
    expect(updateHandler).toHaveBeenCalledTimes(1);
    expect(updateHandler.mock.calls[0][0]).toEqual(widgetArgs);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("UPDATE WIDGET");
    expect(messages[0]).toContain("QuickBooks company (realm) ID: 9130");
    expect(mockQuickbooksClientClass.getRealmId).toHaveBeenCalledTimes(2);
    expect(messages[0]).toContain('- widget.Name: "Renamed"');
  });

  it("does not run the mutation when the client declines", async () => {
    await connect({ elicitation: {} }, () => ({ action: "decline" }));
    const result = await callTool("update_widget");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("blocked (declined)") });
    expect(updateHandler).not.toHaveBeenCalled();
  });

  it("fails closed for a client without elicitation support", async () => {
    await connect({});
    const result = await callTool("update_widget");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("blocked (unsupported-client)") });
    expect(updateHandler).not.toHaveBeenCalled();
    expect(mockQuickbooksClientClass.getRealmId).not.toHaveBeenCalled();
  });

  it("leaves read tools unaffected and hides disabled tools", async () => {
    await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["get_widget", "update_widget"]);

    const result = await callTool("get_widget");
    expect(result.isError).toBeUndefined();
    expect(readHandler).toHaveBeenCalledTimes(1);
    expect(deleteHandler).not.toHaveBeenCalled();
  });
});
