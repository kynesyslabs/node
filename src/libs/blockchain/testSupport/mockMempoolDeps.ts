import { mock } from "bun:test"
import { mockLogger } from "@/utilities/testSupport/coreMocks"

/**
 * Module mocks shared by the L2PS mempool and handler tests. Each test calls
 * these at top level, before the dynamic import of the module under test, so
 * the module loads against the mocks.
 */

export { mockLogger }

/**
 * What loading the mempool pulls in: the datasource (resolved lazily, so a
 * test can swap its data source after the mock is registered), the chain, the
 * secretary manager and the logger.
 */
export function mockMempoolDeps(getDataSource: () => unknown = () => ({})): void {
    mock.module("@/model/datasource", () => ({
        __esModule: true,
        get dataSource() {
            return getDataSource()
        },
        default: { getInstance: async () => ({ getDataSource }) },
    }))
    mock.module("@/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
    mock.module("@/libs/consensus/v2/types/secretaryManager", () => ({
        __esModule: true,
        AbortConsensusError: class AbortConsensusError extends Error {},
        PEERLIST_PHASE: 3,
        HEAD_ALIGN_WAIT_MS: 2000,
        default: { getInstance: () => ({}) },
    }))
    mockLogger()
}
