/**
 * The bridge private key must never reach a log line or a thrown message.
 *
 * EVMSmartContractManagement.initialize() logs the error of a failed tank
 * and rethrows it to callers that log it again, so the key path is checked
 * end to end: a well-formed key, a malformed key (ethers quotes it in its
 * error) and a keys file read error that quotes the file. The logger and the
 * console are spied; every argument they receive is rendered and searched
 * for the synthetic key text.
 */
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Wallet } from "ethers"

// Synthetic key text only, never a real key
const KEY_BODY = "5e".repeat(32)
const GOOD_KEY = "0x" + KEY_BODY
const MARKER = "KEYMARKERzz"
const BAD_KEY = "0x5e5e" + MARKER
const CHAIN_KEY = "evm.eth.sepolia"
const TANK = "0x" + "ab".repeat(20)

const levels = ["debug", "info", "warning", "warn", "error", "critical", "only", "custom"]
const logger: Record<string, ReturnType<typeof mock>> = {}
for (const level of levels) logger[level] = mock(() => {})

const getBridgePrivateKey = mock((): string | null => GOOD_KEY)

class StubEVM {
    wallet: Wallet | null = null
    async connect() {
        return true
    }
    // Real ethers parsing, so a malformed key fails the way it does in the node
    async connectWallet(privateKey: string) {
        this.wallet = new Wallet(privateKey.trim())
        return this.wallet
    }
    getAddress() {
        return this.wallet.address
    }
    async getContractInstance() {
        return { initialized: async () => true }
    }
}

mock.module("@/utilities/logger", () => ({ default: logger }))
mock.module("@/utilities/JsonConfig", () => ({
    JsonConfig: { getBridgePrivateKey, getTankAbi: () => [] },
}))
mock.module("@/libs/blockchain/chain", () => ({ default: {} }))
mock.module("src/utilities/waiter", () => ({ Waiter: { keys: {} } }))
mock.module("@kynesyslabs/demosdk/xm-localsdk", () => ({ EVM: StubEVM }))
mock.module("@kynesyslabs/demosdk/bridge", () => ({ NativeBridge: class {} }))

const { EVMSmartContractManagement } = await import(
    "../features/bridges/native/EVMSmartContractManagement"
)

// No websocket provider in tests
const listeners = spyOn(
    EVMSmartContractManagement.prototype as any,
    "setupEventListeners",
).mockResolvedValue(undefined)

const consoleSpies = ["log", "info", "warn", "error", "debug"].map(m =>
    spyOn(console, m as "log").mockImplementation(() => {}),
)

function emitted(): string {
    const calls = [...Object.values(logger), ...consoleSpies].flatMap(
        spy => spy.mock.calls,
    )
    return calls.map(args => args.map(a => Bun.inspect(a)).join(" ")).join("\n")
}

function expectNoKeyText(text: string) {
    expect(text).not.toContain(KEY_BODY)
    expect(text).not.toContain(MARKER)
}

async function initializeError(): Promise<Error> {
    try {
        await EVMSmartContractManagement.getInstance().initialize({
            [CHAIN_KEY]: TANK,
        })
    } catch (e) {
        return e as Error
    }
    throw new Error("initialize did not fail")
}

describe("bridge private key logging", () => {
    beforeEach(() => {
        const manager = EVMSmartContractManagement.getInstance() as any
        manager.isInitialized = false
        manager.tanks.clear()
        for (const spy of [...Object.values(logger), ...consoleSpies]) {
            spy.mockClear()
        }
        getBridgePrivateKey.mockReset()
    })

    afterAll(() => {
        listeners.mockRestore()
        for (const spy of consoleSpies) spy.mockRestore()
    })

    test("ethers quotes a malformed key in its error (the leak being guarded)", () => {
        expect(() => new Wallet(BAD_KEY)).toThrow(MARKER)
    })

    test("a tank initialized with its key logs no key material", async () => {
        getBridgePrivateKey.mockReturnValue(GOOD_KEY)

        await EVMSmartContractManagement.getInstance().initialize({
            [CHAIN_KEY]: TANK,
        })

        const text = emitted()
        expect(text).toContain(`Connected to ${CHAIN_KEY} with address`)
        expect(text).toContain(`Tank initialized: ${CHAIN_KEY}`)
        expectNoKeyText(text)
    })

    test("a malformed key fails with a fixed tag and is not logged", async () => {
        getBridgePrivateKey.mockReturnValue(BAD_KEY)

        const error = await initializeError()

        expect(error.message).toBe(
            `Failed to load the bridge private key for ${CHAIN_KEY} (Error)`,
        )
        expect(error.cause).toBeUndefined()
        expectNoKeyText(Bun.inspect(error))
        expectNoKeyText(emitted())
    })

    test.each([
        [
            "Error",
            new Error(
                "Failed to read JSON from file config/bridgePrivateKeys.json: " +
                    `SyntaxError: JSON Parse error: Unexpected identifier "${MARKER}${KEY_BODY}"`,
            ),
        ],
        ["string", `Unexpected identifier "${MARKER}${KEY_BODY}"`],
    ])(
        "a keys file read error (%s) fails with a fixed tag and is not logged",
        async (tag, thrown) => {
            getBridgePrivateKey.mockImplementation(() => {
                throw thrown
            })

            const error = await initializeError()

            expect(error.message).toBe(
                `Failed to read the bridge private key for ${CHAIN_KEY} (${tag})`,
            )
            expect(error.cause).toBeUndefined()
            expectNoKeyText(Bun.inspect(error))
            expectNoKeyText(emitted())
        },
    )
})
