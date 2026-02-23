import { runRpcLoadgen } from "./rpc_loadgen"
import { runTransferLoadgen } from "./transfer_loadgen"
import { runTransferRamp } from "./transfer_ramp"

const scenario = (process.env.SCENARIO ?? "rpc").toLowerCase()

switch (scenario) {
  case "rpc":
    await runRpcLoadgen()
    break
  case "transfer":
    await runTransferLoadgen()
    break
  case "transfer_ramp":
    await runTransferRamp()
    break
  default:
    throw new Error(`Unknown SCENARIO: ${scenario}. Valid: rpc, transfer, transfer_ramp`)
}
