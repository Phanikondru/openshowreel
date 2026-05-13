#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runJsx } from "./bridge.js";
import { tools } from "./tools.js";

const server = new McpServer({ name: "openshowreel", version: "0.1.0" });

for (const tool of tools) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.schema },
    async (args: Record<string, unknown>) => {
      try {
        const out = await runJsx(tool.build(args ?? {}));
        return { content: [{ type: "text" as const, text: out }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `After Effects error: ${message}` }], isError: true };
      }
    },
  );
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`openshowreel MCP server running (${tools.length} tools) — stdio`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
