// Wires the staking page routes into the RPC server with the node's real
// dependencies: identity, config, allowlist, anchor and Helius endpoint.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import type { BunServer } from "@/libs/network/bunServer"
import { isAllowlistedMint } from "./nftAllowlist"
import { HourlyBudget, STAKING_PAGE_RPC_PER_HOUR } from "./pageBudget"
import { normalizeDemosAddress } from "./proofBytes"
import { mintHolder, nodeHoldsSeat, recordProofOnDemos } from "./proofSubmit"
import { resolveSolanaEndpoints } from "./solanaRpc"
import {
    STAKING_PAGE_PATH,
    STAKING_RELAY_PATH,
    STAKING_SUBMIT_PATH,
    createValidationHandlers,
} from "./validationHandlers"

const PAGE_FILE = join(dirname(fileURLToPath(import.meta.url)), "validation.html")

let pageCache: string | null = null
function pageHtml(): string {
    if (pageCache === null) pageCache = readFileSync(PAGE_FILE, "utf8")
    return pageCache
}

function ownAddress(): string {
    const hex = getSharedState.publicKeyHex
    const normalized = hex ? normalizeDemosAddress(hex) : null
    if (normalized === null) throw new Error("node identity is not loaded")
    return normalized
}

/** The keyed Helius endpoint, the only one the page relay uses. */
function heliusUrl(): string | null {
    return resolveSolanaEndpoints().find(url => url.includes("helius-rpc.com")) ?? null
}

export function registerStakingValidationRoutes(server: BunServer): void {
    const handlers = createValidationHandlers({
        pageHtml,
        ownAddress,
        solanaRpcUrl: heliusUrl,
        budget: new HourlyBudget(STAKING_PAGE_RPC_PER_HOUR),
        nodeHoldsSeat: () => nodeHoldsSeat(ownAddress()),
        mintHolder,
        isAllowlistedMint,
        recordProof: recordProofOnDemos,
    })
    server.get(STAKING_PAGE_PATH, req => handlers.page(req))
    server.post(STAKING_RELAY_PATH, req => handlers.relay(req))
    server.post(STAKING_SUBMIT_PATH, req => handlers.submit(req))
    log.info(
        `[RPC] Staking page routes registered: ${STAKING_PAGE_PATH}, ${STAKING_RELAY_PATH}, ${STAKING_SUBMIT_PATH} (served while unstaked)`,
    )
}
