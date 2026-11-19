import { dirname, join } from "node:path"
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

/**
 * Serves `repository` for every entity through both datasource specifiers,
 * the module-level `dataSource` and the `getInstance()` singleton alike.
 */
export function mockDatasource(repository: unknown): void {
    const factory = () => ({
        __esModule: true,
        dataSource: { getRepository: () => repository },
        default: {
            getInstance: async () => ({
                getDataSource: () => ({ getRepository: () => repository }),
            }),
        },
    })
    mock.module("src/model/datasource", factory)
    mock.module("@/model/datasource", factory)
}

/**
 * The SDK's xm-localsdk barrel loads the Tron module, which does not
 * initialise under bun test; this serves the chain modules one by one.
 */
export function mockXmLocalSdk(): void {
    const dir = dirname(require.resolve("@kynesyslabs/demosdk/xm-localsdk"))
    const load = (file: string) => require(join(dir, file))
    mock.module("@kynesyslabs/demosdk/xm-localsdk", () => ({
        XRPL: load("xrp.js").XRPL,
        EVM: load("evm.js").EVM,
        IBC: load("ibc.js").IBC,
        TON: load("ton.js").TON,
        SOLANA: load("solana.js").SOLANA,
        MULTIVERSX: load("multiversx.js").MULTIVERSX,
        NEAR: load("near.js").NEAR,
        BTC: load("btc.js").BTC,
        APTOS: load("aptos.js").APTOS,
    }))
}

/**
 * Serves an empty repository per entity through both datasource specifiers:
 * every read finds nothing and every save returns its row.
 */
export function mockEntityDatasource(): void {
    const repoFor = (name: string) => ({
        target: { name },
        create: (row: unknown) => ({ ...(row as object) }),
        findOneBy: async () => null,
        findOne: async () => null,
        find: async () => [],
        save: async (row: unknown) => row,
    })
    const dataSource = { getRepository: (entity: any) => repoFor(entity?.name ?? String(entity)) }
    const factory = () => ({
        __esModule: true,
        dataSource,
        default: { getInstance: async () => ({ getDataSource: () => dataSource }) },
    })
    mock.module("src/model/datasource", factory)
    mock.module("@/model/datasource", factory)
}

/**
 * Keeps `l2psGate` dormant without loading it. The real gate reads the node's
 * shared state, whose module graph the stubs of a handler test cannot load;
 * the gate has its own tests.
 */
export function mockL2psGateDormant(): void {
    mock.module("@/forks/l2psGate", () => ({
        L2PS_TX_TYPES: new Set<string>(),
        L2PS_GATE_REFUSAL: "L2PS is not enabled on this network (fork l2psGate)",
        l2psOff: () => false,
        l2psOffAt: () => false,
        isL2psTx: () => false,
        l2psGateRefusal: () => null,
    }))
}
