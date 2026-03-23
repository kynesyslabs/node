import { getRunConfig, writeJson } from "../../framework/io"
import { createDemosMCPServer } from "../../../../../src/features/mcp/MCPServer"

export async function runMcpServerCreationSmoke() {
  const defaultServer = createDemosMCPServer()
  const defaultStatus = defaultServer.getStatus()
  const defaultConfig = (defaultServer as any).config

  const customServer = createDemosMCPServer({
    transport: "sse",
    host: "0.0.0.0",
    port: 4100,
  })
  const customStatus = customServer.getStatus()
  const customConfig = (customServer as any).config

  const checks = {
    defaultIdentity: defaultStatus.serverName === "demos-network-mcp" && defaultStatus.serverVersion === "1.0.0",
    defaultOfflineAndEmpty: defaultStatus.isRunning === false && defaultStatus.toolCount === 0,
    defaultTransport: defaultConfig.transport.type === "stdio" && defaultConfig.transport.host === "localhost" && defaultConfig.transport.port === 3001,
    customTransport: customConfig.transport.type === "sse" && customConfig.transport.host === "0.0.0.0" && customConfig.transport.port === 4100,
    customOfflineAndEmpty: customStatus.isRunning === false && customStatus.toolCount === 0,
  }

  const ok = Object.values(checks).every(Boolean)
  const run = getRunConfig()
  const summary = {
    scenario: "mcp_server_creation_smoke",
    ok,
    checks,
    defaultStatus,
    customStatus,
    defaultTransport: defaultConfig.transport,
    customTransport: customConfig.transport,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/mcp/mcp_server_creation_smoke.summary.json`, summary)
  console.log(JSON.stringify({ mcp_server_creation_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("mcp_server_creation_smoke failed: MCP server creation defaults did not match expectations")
  }
}

if (import.meta.main) {
  await runMcpServerCreationSmoke()
}
