/**
 * The bridge private key must never reach a log line or a thrown message.
 *
 * EVMSmartContractManagement.initialize() logs the error of a failed tank
 * and rethrows it to callers that log it again, so the key path is checked
 * end to end: a well-formed key, a malformed key (ethers quotes it in its
 * error), a malformed mnemonic, and a keys file read error that quotes the
 * file. The logger and the console are spied; every argument they receive is
 * rendered and searched for the synthetic key text. A thrown message names
 * the cause only by the error's string code, else its name.
 *
 * Run this file in its own `bun test` process, because its `mock.module`
 * stubs last for the whole process.
 */
import {
    afterAll,
    beforeEach,
    describe,
    expect,
    mock,
    spyOn,
    test,
} from "bun:test"
import { Contract, Wallet } from "ethers"
import { EVM as SdkEVM } from "@kynesyslabs/demosdk/xmcore/evm"

// Synthetic key text only, never a real key or phrase
const KEY_BODY = "5e".repeat(32)
const GOOD_KEY = "0x" + KEY_BODY
const MARKER = "KEYMARKERzz"
const BAD_KEY = "0x5e5e" + MARKER
// Has spaces, so the SDK takes it as a mnemonic; not a valid BIP-39 phrase
const BAD_PHRASE = `${MARKER} lunar orbit ${KEY_BODY} quartz`
const CHAIN_KEY = "evm.eth.sepolia"
const TANK = "0x" + "ab".repeat(20)

const levels = [
    "debug",
    "info",
    "warning",
    "warn",
    "error",
    "critical",
    "only",
    "custom",
]
const logger: Record<string, ReturnType<typeof mock>> = {}
for (const level of levels) logger[level] = mock(() => {})

const getBridgePrivateKey = mock((): string | null => GOOD_KEY)

// The SDK's own connectWallet and getAddress, so a malformed key or mnemonic
// fails the way it does in the node. No RPC URL, so no provider and no
// network; only the network calls are stubbed
class StubEVM extends SdkEVM {
    constructor() {
        super("")
    }
    override async connect() {
        return true
    }
    override async getContractInstance() {
        return { initialized: async () => true } as unknown as Contract
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

    test("a malformed key fails with the ethers code and is not logged", async () => {
        getBridgePrivateKey.mockReturnValue(BAD_KEY)

        const error = await initializeError()

        expect(error.message).toBe(
            `Failed to load the bridge private key for ${CHAIN_KEY} (INVALID_ARGUMENT)`,
        )
        expect(error.cause).toBeUndefined()
        expectNoKeyText(Bun.inspect(error))
        expectNoKeyText(emitted())
    })

    test("a malformed mnemonic fails with a fixed tag and is not logged", async () => {
        // The real SDK path: a phrase with spaces is checked as a mnemonic
        await expect(new SdkEVM("").connectWallet(BAD_PHRASE)).rejects.toThrow(
            "Invalid mnemonic phrase",
        )
        getBridgePrivateKey.mockReturnValue(BAD_PHRASE)

        const error = await initializeError()

        expect(error.message).toBe(
            `Failed to load the bridge private key for ${CHAIN_KEY} (Error)`,
        )
        expect(error.cause).toBeUndefined()
        expectNoKeyText(Bun.inspect(error))
        expectNoKeyText(emitted())
    })

    // JsonConfig.readJsonFromFile rewraps every read and parse error in a
    // plain Error with no code, its message holding the original error
    test.each([
        [
            "a parse error",
            "Error",
            new Error(
                "Failed to read JSON from file config/bridgePrivateKeys.json: " +
                    `SyntaxError: JSON Parse error: Unexpected identifier "${MARKER}${KEY_BODY}"`,
            ),
        ],
        [
            "a read error",
            "Error",
            new Error(
                "Failed to read JSON from file config/bridgePrivateKeys.json: " +
                    `Error: EACCES: permission denied, open '${MARKER}${KEY_BODY}'`,
            ),
        ],
        [
            // A code that is not a string falls back to the error's name
            "a TypeError with a numeric code",
            "TypeError",
            Object.assign(new TypeError(`bad key ${MARKER}${KEY_BODY}`), {
                code: 13,
            }),
        ],
        [
            "a thrown string",
            "string",
            `Unexpected identifier "${MARKER}${KEY_BODY}"`,
        ],
    ])(
        "a keys file read failure (%s) fails with a fixed message and is not logged",
        async (_label, kind, thrown) => {
            getBridgePrivateKey.mockImplementation(() => {
                throw thrown
            })

            const error = await initializeError()

            expect(error.message).toBe(
                `Failed to read the bridge private key for ${CHAIN_KEY}: ` +
                    `keys file unreadable, not valid JSON, or not a JSON object (${kind})`,
            )
            expect(error.cause).toBeUndefined()
            expectNoKeyText(Bun.inspect(error))
            expectNoKeyText(emitted())
        },
    )
})
