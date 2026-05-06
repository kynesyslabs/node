import { peerHandlers } from "./peerHandlers"
import { blockHandlers } from "./blockHandlers"
import { transactionHandlers } from "./transactionHandlers"
import { identityHandlers } from "./identityHandlers"
import { tlsnotaryHandlers } from "./tlsnotaryHandlers"
import { l2psHandlers } from "./l2psHandlers"
import { miscHandlers } from "./miscHandlers"
import { validatorHandlers } from "./validatorHandlers"
import { governanceHandlers } from "./governanceHandlers"
import { storageProgramHandlers } from "./storageProgramHandlers"
import type { NodeCallHandler } from "./types"

export type { NodeCallHandler } from "./types"

export const handlerRegistry: Record<string, NodeCallHandler> = {
    ...peerHandlers,
    ...blockHandlers,
    ...transactionHandlers,
    ...identityHandlers,
    ...tlsnotaryHandlers,
    ...l2psHandlers,
    ...miscHandlers,
    ...validatorHandlers,
    ...governanceHandlers,
    ...storageProgramHandlers,
}
