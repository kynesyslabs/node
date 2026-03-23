import { getRunConfig, writeJson } from "../../framework/io"
import { createDemosNetworkTools } from "../../../../../src/features/mcp/tools/demosTools"

function namesOf(tools: { name: string }[]) {
  return tools.map(tool => tool.name).sort()
}

export async function runMcpToolFactorySmoke() {
  const defaultTools = namesOf(createDemosNetworkTools())
  const blockchainOnly = namesOf(createDemosNetworkTools({
    enableNetworkTools: false,
    enablePeerTools: false,
  }))
  const peerAndNetworkOnly = namesOf(createDemosNetworkTools({
    enableBlockchainTools: false,
  }))

  const checks = {
    defaultCount: defaultTools.length === 7,
    defaultNames: JSON.stringify(defaultTools) === JSON.stringify([
      "get_block_by_number",
      "get_chain_height",
      "get_last_block",
      "get_network_status",
      "get_node_identity",
      "get_peer_count",
      "get_peer_list",
    ]),
    blockchainOnlyCount: blockchainOnly.length === 3,
    blockchainOnlyNames: JSON.stringify(blockchainOnly) === JSON.stringify([
      "get_block_by_number",
      "get_chain_height",
      "get_last_block",
    ]),
    peerAndNetworkOnlyCount: peerAndNetworkOnly.length === 4,
    peerAndNetworkOnlyNames: JSON.stringify(peerAndNetworkOnly) === JSON.stringify([
      "get_network_status",
      "get_node_identity",
      "get_peer_count",
      "get_peer_list",
    ]),
  }

  const ok = Object.values(checks).every(Boolean)
  const run = getRunConfig()
  const summary = {
    scenario: "mcp_tool_factory_smoke",
    ok,
    checks,
    defaultTools,
    blockchainOnly,
    peerAndNetworkOnly,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/mcp/mcp_tool_factory_smoke.summary.json`, summary)
  console.log(JSON.stringify({ mcp_tool_factory_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("mcp_tool_factory_smoke failed: MCP tool factory output did not match expectations")
  }
}

if (import.meta.main) {
  await runMcpToolFactorySmoke()
}
