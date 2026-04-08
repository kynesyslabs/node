import { peerHandlers } from "./peerHandlers"
import { blockHandlers } from "./blockHandlers"
import { transactionHandlers } from "./transactionHandlers"
import { identityHandlers } from "./identityHandlers"
import { tlsnotaryHandlers } from "./tlsnotaryHandlers"
import { tokenHandlers } from "./tokenHandlers"
import { l2psHandlers } from "./l2psHandlers"
import { miscHandlers } from "./miscHandlers"
import type { NodeCallHandler } from "./types"

export type { NodeCallHandler } from "./types"

export const handlerRegistry: Record<string, NodeCallHandler> = {
    ...peerHandlers,
    ...blockHandlers,
    ...transactionHandlers,
    ...identityHandlers,
    ...tlsnotaryHandlers,
    ...tokenHandlers,
    ...l2psHandlers,
    ...miscHandlers,
}
