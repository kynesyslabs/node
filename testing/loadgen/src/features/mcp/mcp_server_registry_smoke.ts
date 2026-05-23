import { z } from "zod"
import { getRunConfig, writeJson } from "../../framework/io"
import { MCPServerManager } from "../../../../../src/features/mcp/MCPServer"

export async function runMcpServerRegistrySmoke() {
  const manager = new MCPServerManager({
    name: "test-mcp",
    version: "0.1.0",
  })

  manager.registerTool({
    name: "tool_alpha",
    description: "alpha",
    inputSchema: z.object({}),
    handler: async () => ({ ok: true }),
  })
  manager.registerTool({
    name: "tool_beta",
    description: "beta",
    inputSchema: z.object({ value: z.number() }),
    handler: async (args: { value: number }) => ({ doubled: args.value * 2 }),
  })

  const statusBefore = manager.getStatus()
  const registeredBefore = manager.getRegisteredTools().sort()

  manager.unregisterTool("tool_missing")
  manager.unregisterTool("tool_alpha")

  const statusAfter = manager.getStatus()
  const registeredAfter = manager.getRegisteredTools().sort()

  let registerWhileRunningError: string | null = null
  try {
    (manager as any).isRunning = true
    manager.registerTool({
      name: "tool_gamma",
      description: "gamma",
      inputSchema: z.object({}),
      handler: async () => ({ ok: true }),
    })
  } catch (error) {
    registerWhileRunningError = (error as Error).message
  } finally {
    (manager as any).isRunning = false
  }

  const checks = {
    statusBeforeCount: statusBefore.toolCount === 2,
    statusAfterCount: statusAfter.toolCount === 1,
    registeredBefore: JSON.stringify(registeredBefore) === JSON.stringify(["tool_alpha", "tool_beta"]),
    registeredAfter: JSON.stringify(registeredAfter) === JSON.stringify(["tool_beta"]),
    statusNameAndVersion: statusBefore.serverName === "test-mcp" && statusBefore.serverVersion === "0.1.0",
    runningRegisterRejected: registerWhileRunningError === "Cannot register tools while server is running",
  }

  const ok = Object.values(checks).every(Boolean)
  const run = getRunConfig()
  const summary = {
    scenario: "mcp_server_registry_smoke",
    ok,
    checks,
    statusBefore,
    statusAfter,
    registeredBefore,
    registeredAfter,
    registerWhileRunningError,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/mcp/mcp_server_registry_smoke.summary.json`, summary)
  console.log(JSON.stringify({ mcp_server_registry_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("mcp_server_registry_smoke failed: MCP registry behavior did not match expectations")
  }
}

if (import.meta.main) {
  await runMcpServerRegistrySmoke()
}
