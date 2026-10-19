/**
 * The modules the L2PS handlers reach for, replaced for a test.
 *
 * Call it before the handlers are imported: a static import would load the
 * real mempool first and cycle back through the handler index.
 */
import { jest } from "bun:test"

export interface HandlerMockParts {
    /** What the history table reads answer. */
    executor: Record<string, unknown>
    mempool?: Record<string, unknown>
    /** Stands in for the payload resolver; inert by default. */
    payload?: Record<string, unknown>
    sharedState?: Record<string, unknown>
    /** The `l2ps` section of the node configuration, when a test reads it. */
    config?: Record<string, unknown>
}

export function mockHandlerModules(parts: HandlerMockParts): void {
    jest.mock("../../blockchain/l2ps_mempool", () => ({
        __esModule: true,
        default: parts.mempool ?? {},
        L2PS_STATUS: { EXECUTED: "executed", BATCHED: "batched", CONFIRMED: "confirmed" },
    }))
    jest.mock("../../l2ps/L2PSTransactionExecutor", () => ({ __esModule: true, default: parts.executor }))
    jest.mock("@/libs/l2ps/historyPayload", () => parts.payload ?? { resolveHistoryEntry: jest.fn(), subnetDecryptor: jest.fn() })
    jest.mock("src/utilities/sharedState", () => ({ getSharedState: parts.sharedState ?? {} }))
    if (parts.config) {
        jest.mock("src/config", () => ({ Config: { getInstance: () => ({ l2ps: parts.config }) } }))
    }
    jest.mock("src/utilities/logger", () => ({
        __esModule: true,
        default: new Proxy({}, { get: () => jest.fn() }),
    }))
}
