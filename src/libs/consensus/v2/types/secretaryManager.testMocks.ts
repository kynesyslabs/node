import { jest } from "bun:test"

/**
 * Module mocks every SecretaryManager test needs before importing it: a
 * silent logger, the test's own shared state, and stub peer and chain modules
 * so the import does not pull in the network or the database.
 */
export function mockSecretaryDeps(sharedState: Record<string, any>): void {
    jest.mock("src/utilities/logger", () => ({
        __esModule: true,
        default: {
            debug: jest.fn(),
            info: jest.fn(),
            warning: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            only: jest.fn(),
        },
    }))
    jest.mock("src/utilities/sharedState", () => ({
        __esModule: true,
        default: sharedState,
        getSharedState: sharedState,
    }))
    jest.mock("src/libs/peer", () => ({
        Peer: class {},
        PeerManager: { getInstance: () => ({}) },
    }))
    jest.mock("src/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
}
