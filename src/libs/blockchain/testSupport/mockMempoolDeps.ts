import { jest, mock } from "bun:test"

/**
 * Module mocks shared by the L2PS mempool and handler tests. Each test calls
 * these at top level, before the dynamic import of the module under test, so
 * the module loads against the mocks.
 */

/** Silences the logger; `specifier` is the path the module under test imports it by. */
export function mockLogger(specifier = "@/utilities/logger"): void {
    mock.module(specifier, () => ({
        __esModule: true,
        default: {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            warning: jest.fn(),
            error: jest.fn(),
            only: jest.fn(),
        },
    }))
}

/**
 * What loading the mempool pulls in: the datasource (resolved lazily, so a
 * test can swap its data source after the mock is registered), the chain, the
 * secretary manager and the logger.
 */
export function mockMempoolDeps(getDataSource: () => unknown = () => ({})): void {
    mock.module("@/model/datasource", () => ({
        __esModule: true,
        default: { getInstance: async () => ({ getDataSource }) },
    }))
    mock.module("@/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
    mock.module("@/libs/consensus/v2/types/secretaryManager", () => ({
        __esModule: true,
        default: { getInstance: () => ({}) },
    }))
    mockLogger()
}
