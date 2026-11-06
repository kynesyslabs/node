import { jest, mock } from "bun:test"

/**
 * Module mocks most unit tests need before they import the module under test.
 * Call them at top level, ahead of that dynamic import, so the module loads
 * against the mocks.
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
            custom: jest.fn(),
        },
    }))
}

/**
 * Serves `state` as the shared state. Code that calls getInstance() needs
 * `asInstance`; code that reads the default export directly needs it off.
 */
export function mockSharedState(
    state: Record<string, unknown>,
    { asInstance = false }: { asInstance?: boolean } = {},
): void {
    mock.module("src/utilities/sharedState", () => ({
        __esModule: true,
        default: asInstance ? { getInstance: () => state } : state,
        getSharedState: state,
    }))
}

/** Logger and shared state together, the pair nearly every node test mocks. */
export function mockCore(
    state: Record<string, unknown>,
    options?: { asInstance?: boolean },
): void {
    mockLogger("src/utilities/logger")
    mockSharedState(state, options)
}
