/**
 * Witness generation against the compiled settlement circuit: every valid
 * batch has a witness, and every tampered statement fails a constraint. The
 * tampered inputs are kept consistent everywhere except the one property
 * under test (the public hash is recomputed the way the circuit packs it),
 * and each failure is matched to the circuit line that rejects it, so a test
 * cannot pass because some unrelated constraint broke. The public hash
 * itself is checked against settlementPublicHash, the verifier's side.
 *
 * Needs the compiled circuit (bun run setup --only zk --zk --zk-generate);
 * skipped without it.
 */
import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { poseidon8 } from "poseidon-lite/poseidon8"
import * as snarkjs from "snarkjs"
import { acct, fixtureBatch, PROVEN_BATCHES } from "../settlement/__fixtures__/batches"
import { buildSettlementCircuitInput } from "../settlement/circuitInput"
import {
    accountLimbs,
    commitmentsHash,
    FIELD_ORDER as P,
    SETTLEMENT_ACCOUNTS as M,
    SETTLEMENT_PUBLIC_SIGNALS,
    SETTLEMENT_TRANSFERS as N,
    SettlementEncodingError,
    settlementPublicHash,
} from "../settlement/encoding"
import { planSettlement } from "../settlement/planner"
import { settlementFiles } from "./settlementArtifacts"

const files = settlementFiles()
const built = fs.existsSync(files.wasm)
const CIRCUIT_LINES = fs
    .readFileSync(path.join(path.dirname(files.dir), "..", "circuits", "l2ps_settlement.circom"), "utf8")
    .split("\n")

type Signals = Record<string, bigint[]>

interface RawTransfer {
    signer: string
    to: string
    amount: bigint
    fee: bigint
    nonce: bigint
    salt: bigint
    senderIndex: number
    receiverIndex: number
}

interface RawAccount {
    account: string
    balance: bigint
    delta: bigint
}

const ZERO = "0x" + "00".repeat(32)

/**
 * Circuit input from explicit slots, with no checks at all: the circuit is
 * the only judge. `null` is an inactive slot (all zero). signerHi/signerLo
 * are who signed each commitment; they open the commitment here but are not
 * a circuit input.
 */
function raw(transfers: (RawTransfer | null)[], accounts: (RawAccount | null)[]): Signals {
    const s: Signals = {}
    const names = [
        "transferActive", "signerHi", "signerLo", "nonce", "fee", "toHi", "toLo", "amount", "salt",
        "senderIndex", "receiverIndex",
    ]
    for (const n of names) s[n] = Array(N).fill(0n)
    for (const n of ["accountActive", "accountHi", "accountLo", "balanceBefore", "deltaNegative", "deltaMagnitude"]) {
        s[n] = Array(M).fill(0n)
    }
    transfers.forEach((t, i) => {
        if (t === null) return
        const [sh, sl] = accountLimbs(t.signer)
        const [th, tl] = accountLimbs(t.to)
        s.transferActive[i] = 1n
        s.signerHi[i] = sh
        s.signerLo[i] = sl
        s.toHi[i] = th
        s.toLo[i] = tl
        s.nonce[i] = t.nonce
        s.fee[i] = t.fee
        s.amount[i] = t.amount
        s.salt[i] = t.salt
        s.senderIndex[i] = BigInt(t.senderIndex)
        s.receiverIndex[i] = BigInt(t.receiverIndex)
    })
    accounts.forEach((a, j) => {
        if (a === null) return
        const [h, l] = accountLimbs(a.account)
        s.accountActive[j] = 1n
        s.accountHi[j] = h
        s.accountLo[j] = l
        s.balanceBefore[j] = a.balance
        s.deltaNegative[j] = a.delta < 0n ? 1n : 0n
        s.deltaMagnitude[j] = a.delta < 0n ? -a.delta : a.delta
    })
    return seal(rehash(s))
}

const commitmentOf = (s: Signals, i: number): bigint =>
    s.transferActive[i] === 0n
        ? 0n
        : poseidon8([s.signerHi[i], s.signerLo[i], s.toHi[i], s.toLo[i], s.amount[i], s.fee[i], s.nonce[i], s.salt[i]])

/** Recomputes the commitments hash from the slots, in the given slot order. */
function rehash(s: Signals, order: number[] = [...Array(N).keys()]): Signals {
    s.commitmentsHash = [commitmentsHash(order.map(i => commitmentOf(s, i)))]
    return s
}

/**
 * The public hash as the circuit packs it from its own inputs (Interface
 * v1.1), reduced mod p like the witness calculator does. Written from the
 * spec, independently of settlementPublicHash.
 */
function circuitHash(s: Signals): bigint {
    const e: bigint[] = [s.commitmentsHash[0]]
    for (let i = 0; i < N; i++) {
        e.push(s.fee[i] + (s.nonce[i] << 128n) + (s.senderIndex[i] << 192n) + (s.transferActive[i] << 200n))
    }
    let flags = 0n
    for (let j = 0; j < M; j++) {
        e.push(s.accountHi[j], s.accountLo[j], s.balanceBefore[j], s.deltaMagnitude[j])
        flags += s.accountActive[j] * 4n ** BigInt(j) + s.deltaNegative[j] * 2n * 4n ** BigInt(j)
    }
    e.push(flags)
    while (e.length % 7 !== 0) e.push(0n)
    let h = 0n
    for (let k = 0; k < e.length; k += 7) h = poseidon8([h, ...e.slice(k, k + 7).map(x => ((x % P) + P) % P)])
    return h
}

/** Sets the public hash to the one the circuit computes from these inputs. */
function seal(s: Signals): Signals {
    s.publicHash = [circuitHash(s)]
    return s
}

/**
 * Circuit input from the planner and builder, with the Interface v1 signals
 * (the validator's statement) kept as `statement` and the signer limbs taken
 * from it.
 */
function fromBatch(make: () => { transfers: any; balances: any; nonces: any }): Signals {
    const { transfers, balances, nonces } = make()
    const { input, publicSignals } = buildSettlementCircuitInput(planSettlement(transfers, balances, nonces))
    const s: Signals = {}
    for (const [k, v] of Object.entries(input)) s[k] = (Array.isArray(v) ? v : [v]).map(x => BigInt(x))
    s.statement = publicSignals
    s.signerHi = publicSignals.slice(1 + N, 1 + 2 * N)
    s.signerLo = publicSignals.slice(1 + 2 * N, 1 + 3 * N)
    return s
}

const NOT_INPUTS = new Set(["signerHi", "signerLo", "statement"])
const SCALARS = new Set(["commitmentsHash", "publicHash"])
const toInput = (s: Signals) =>
    Object.fromEntries(
        Object.entries(s)
            .filter(([k]) => !NOT_INPUTS.has(k))
            .map(([k, v]) => [k, SCALARS.has(k) ? v[0].toString() : v.map(String)]),
    )

async function witness(s: Signals): Promise<void> {
    await (snarkjs as any).wtns.calculate(toInput(s), files.wasm, { type: "mem" })
}

/** The witness fails, and the circuit line that rejects it contains `where`. */
async function rejects(s: Signals, where: string): Promise<void> {
    let message: string | undefined
    try {
        await witness(s)
    } catch (error) {
        message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toBeDefined()
    expect(message).toContain("Assert Failed")
    // Innermost template first; the main template's line names the check.
    const lines = [...(message as string).matchAll(/L2PSSettlement_\d+ line: (\d+)/g)].map(m => Number(m[1]))
    expect(lines.length).toBeGreaterThan(0)
    expect(CIRCUIT_LINES[lines[lines.length - 1] - 1]).toContain(where)
}

// a(0x11) 1000 -> b(0x22) 700 + 10; b -> c(0x33) 650 + 10; c -> c 40 + 10.
const a = acct(0x11)
const b = acct(0x22)
const c = acct(0x33)
const d = acct(0x44)
const base = (over: Partial<RawTransfer> = {}): RawTransfer => ({
    signer: a, to: b, amount: 700n, fee: 10n, nonce: 1n, salt: 21n, senderIndex: 0, receiverIndex: 1, ...over,
})

describe.skipIf(!built)("settlement circuit witnesses", () => {
    describe("valid batches", () => {
        for (const make of [...PROVEN_BATCHES, fixtureBatch]) {
            it(make().name, async () => {
                await witness(fromBatch(make))
            })
        }
        it("the raw builder agrees with the planner on the fixture batch", () => {
            const fromPlanner = toInput(fromBatch(fixtureBatch))
            const built = raw(
                [
                    base(),
                    { signer: b, to: c, amount: 650n, fee: 10n, nonce: 1n, salt: 22n, senderIndex: 1, receiverIndex: 2 },
                    { signer: c, to: c, amount: 40n, fee: 10n, nonce: 1n, salt: 23n, senderIndex: 2, receiverIndex: 2 },
                ],
                [
                    { account: a, balance: 1_000n, delta: -710n },
                    { account: b, balance: 0n, delta: 40n },
                    { account: c, balance: 5n, delta: 640n },
                ],
            )
            // Includes the public hash: circuit packing here, settlementPublicHash there.
            expect(toInput(built)).toEqual(fromPlanner)
        })
    })

    describe("public hash: circuit and verifier agree", () => {
        const PUBLIC_HASH = "sponge[CHUNKS - 1].out === publicHash"

        for (const make of [...PROVEN_BATCHES, fixtureBatch]) {
            it(`${make().name}: the circuit's packing is settlementPublicHash`, () => {
                const s = fromBatch(make)
                expect(circuitHash(s)).toBe(settlementPublicHash(s.statement))
                expect(s.publicHash).toEqual([settlementPublicHash(s.statement)])
            })
        }

        it("a public hash of another statement fails", async () => {
            const s = fromBatch(fixtureBatch)
            s.publicHash = [s.publicHash[0] + 1n]
            await rejects(s, PUBLIC_HASH)
        })

        it("every signal of the statement is bound: changing any one fails the proof", async () => {
            const valid = fromBatch(fixtureBatch)
            let checked = 0
            for (let k = 0; k < SETTLEMENT_PUBLIC_SIGNALS; k++) {
                const statement = [...valid.statement]
                const v = statement[k]
                statement[k] = v === 0n ? 1n : v === 1n ? 0n : v + 1n
                let hash: bigint
                try {
                    hash = settlementPublicHash(statement)
                } catch (error) {
                    // Not a statement any verifier hashes, so not one it can accept.
                    expect(error).toBeInstanceOf(SettlementEncodingError)
                    continue
                }
                await rejects({ ...valid, publicHash: [hash] }, PUBLIC_HASH)
                checked++
            }
            expect(checked).toBeGreaterThan(SETTLEMENT_PUBLIC_SIGNALS / 2)
        }, 120_000)

        it("a balance before other than the validator's fails", async () => {
            // The circuit alone accepts any consistent balance; the hash pins
            // it to the validator's own.
            const s = fromBatch(fixtureBatch)
            s.balanceBefore[1] += 1n
            await witness(seal({ ...s }))
            s.publicHash = [settlementPublicHash(s.statement)]
            await rejects(s, PUBLIC_HASH)
        })

        it("signer is not the debited account", async () => {
            // The validator saw c sign transfer 0, which debits a: proving
            // with a's slot misses the validator's hash. Proving with c's slot
            // instead is "commitment signed over another sender" below.
            const s = fromBatch(fixtureBatch)
            const statement = [...s.statement]
            const [ch, cl] = accountLimbs(c)
            statement[1 + N] = ch
            statement[1 + 2 * N] = cl
            s.publicHash = [settlementPublicHash(statement)]
            await rejects(s, PUBLIC_HASH)
        })
    })

    describe("tampered statements fail", () => {
        it("overdraft, with the field arithmetic otherwise consistent", async () => {
            // a holds 700 and pays 710: after - before is still -710 mod p.
            await rejects(
                raw([base()], [
                    { account: a, balance: 700n, delta: -710n },
                    { account: b, balance: 0n, delta: 700n },
                ]),
                "senderAfterRange[i].in <==",
            )
        })

        it("self-transfer that can only pay out of its own credit", async () => {
            await rejects(
                raw([base({ to: a, amount: 500n, receiverIndex: 0 })], [{ account: a, balance: 509n, delta: -10n }]),
                "senderAfterRange[i].in <==",
            )
        })

        it("wrong delta", async () => {
            const s = fromBatch(fixtureBatch)
            s.deltaMagnitude[2] += 1n
            await rejects(seal(s), "balance[N][j] - balanceBefore[j] ===")
        })

        it("delta sign flipped", async () => {
            const s = fromBatch(fixtureBatch)
            s.deltaNegative[0] = 0n
            await rejects(seal(s), "balance[N][j] - balanceBefore[j] ===")
        })

        // Magnitudes and balances before are hashed whole, so they are the
        // verifier's values, and the verifier hashes none at or above 2^128.
        // The circuit alone accepts these field wraps; the hash refuses them.
        const verifierRefuses = (s: Signals, k: number, value: bigint) => {
            const statement = [...s.statement]
            statement[k] = value
            expect(() => settlementPublicHash(statement)).toThrow(`public signal ${k} is out of range`)
        }
        const MAGNITUDE = 1 + 5 * N + 5 * M
        const NEGATIVE = 1 + 5 * N + 4 * M
        const BALANCE = 1 + 5 * N + 3 * M

        it("debit written as a credit of p - x (field wrap)", async () => {
            const s = fromBatch(fixtureBatch)
            expect([s.deltaNegative[0], s.deltaMagnitude[0]]).toEqual([1n, 710n])
            s.deltaNegative[0] = 0n
            s.deltaMagnitude[0] = P - 710n
            await witness(seal(s))
            s.statement[NEGATIVE] = 0n
            verifierRefuses(s, MAGNITUDE, P - 710n)
        })

        it("credit written as a debit of p - x (field wrap)", async () => {
            const s = fromBatch(fixtureBatch)
            s.deltaNegative[1] = 1n
            s.deltaMagnitude[1] = P - 40n
            await witness(seal(s))
            s.statement[NEGATIVE + 1] = 1n
            verifierRefuses(s, MAGNITUDE + 1, P - 40n)
        })

        it("negative zero", async () => {
            const s = raw([base({ amount: 0n })], [
                { account: a, balance: 1_000n, delta: -10n },
                { account: b, balance: 0n, delta: 0n },
            ])
            s.deltaNegative[1] = 1n
            await rejects(seal(s), "deltaNegative[j] * zeroMagnitude[j].out === 0")
        })

        it("balance before written as p - x (an account below zero)", async () => {
            // b "holds -5", receives 700 and ends at 695: every running value
            // after it is in range, only the balance itself is not.
            const s = raw([base()], [
                { account: a, balance: 1_000n, delta: -710n },
                { account: b, balance: P - 5n, delta: 700n },
            ])
            await witness(s)
            verifierRefuses(fromBatch(fixtureBatch), BALANCE + 1, P - 5n)
        })

        it("fee written as p - x (a fee that pays the sender)", async () => {
            const s = raw([base({ fee: P - 5n })], [
                { account: a, balance: 1_000n, delta: -695n },
                { account: b, balance: 0n, delta: 700n },
            ])
            await rejects(s, "feeRange[i].in <==")
        })

        it("amount written as p - x", async () => {
            // A debit of (p - 700) + 10 is a gain of 690 for a; b loses 700.
            await rejects(
                raw([base({ amount: P - 700n, fee: 10n })], [
                    { account: a, balance: 1_000n, delta: 690n },
                    { account: b, balance: 1_000n, delta: -700n },
                ]),
                "amountRange[i].in <==",
            )
        })

        it("unsorted accounts", async () => {
            await rejects(
                raw([base({ senderIndex: 1, receiverIndex: 0 })], [
                    { account: b, balance: 0n, delta: 700n },
                    { account: a, balance: 1_000n, delta: -710n },
                ]),
                "gapRange[j].in <==",
            )
        })

        it("unsorted accounts that differ only in the lo limb", async () => {
            const lo1 = "0x" + "aa".repeat(16) + "01".repeat(16)
            const lo2 = "0x" + "aa".repeat(16) + "02".repeat(16)
            await rejects(
                raw([base({ signer: lo1, to: lo2, senderIndex: 1, receiverIndex: 0 })], [
                    { account: lo2, balance: 0n, delta: 700n },
                    { account: lo1, balance: 1_000n, delta: -710n },
                ]),
                "gapRange[j].in <==",
            )
        })

        it("duplicate account spending the same balance from two slots", async () => {
            await rejects(
                raw(
                    [
                        base({ amount: 990n, nonce: 1n, senderIndex: 0, receiverIndex: 2 }),
                        base({ amount: 990n, nonce: 2n, salt: 22n, senderIndex: 1, receiverIndex: 2 }),
                    ],
                    [
                        { account: a, balance: 1_000n, delta: -1_000n },
                        { account: a, balance: 1_000n, delta: -1_000n },
                        { account: b, balance: 0n, delta: 1_980n },
                    ],
                ),
                "gapRange[j].in <==",
            )
        })

        it("commitment signed over another sender than the debited account", async () => {
            // c signed a commitment from c; a's slot pays.
            await rejects(
                raw([base({ signer: c })], [
                    { account: a, balance: 1_000n, delta: -710n },
                    { account: b, balance: 0n, delta: 700n },
                ]),
                "batchHash.out === commitmentsHash",
            )
        })

        it("receiver is not the committed one", async () => {
            // Committed to b, credited to c.
            const s = raw([base()], [
                { account: a, balance: 1_000n, delta: -710n },
                { account: c, balance: 0n, delta: 700n },
            ])
            await rejects(s, "receiverHi[i].out === toHi[i]")
        })

        describe("inactive slot with a nonzero value", () => {
            const valid = () =>
                raw([base()], [
                    { account: a, balance: 1_000n, delta: -710n },
                    { account: b, balance: 0n, delta: 700n },
                ])
            const cases: [string, (s: Signals) => void, string][] = [
                ["account limb", s => (s.accountHi[2] = 1n), "accountHi[j] * accountIdle[j] === 0"],
                ["account lo limb", s => (s.accountLo[5] = 7n), "accountLo[j] * accountIdle[j] === 0"],
                ["balance", s => (s.balanceBefore[2] = 5n), "balanceBefore[j] * accountIdle[j] === 0"],
                ["delta magnitude", s => (s.deltaMagnitude[M - 1] = 1n), "deltaMagnitude[j] * accountIdle[j] === 0"],
                ["delta sign", s => (s.deltaNegative[3] = 1n), "deltaNegative[j] * accountIdle[j] === 0"],
                ["fee", s => (s.fee[1] = 1n), "fee[i] * transferIdle[i] === 0"],
                ["nonce", s => (s.nonce[N - 1] = 1n), "nonce[i] * transferIdle[i] === 0"],
                ["amount", s => (s.amount[1] = 1n), "amount[i] * transferIdle[i] === 0"],
                ["salt", s => (s.salt[1] = 1n), "salt[i] * transferIdle[i] === 0"],
                ["sender index", s => (s.senderIndex[1] = 1n), "senderSel[i].enable <=="],
                ["receiver index", s => (s.receiverIndex[1] = 1n), "receiverSel[i].enable <=="],
                ["receiver limb", s => (s.toLo[1] = 1n), "receiverLo[i].out === toLo[i]"],
            ]
            it("the untouched base witness is valid", async () => {
                await witness(valid())
            })
            for (const [name, tamper, where] of cases) {
                it(name, async () => {
                    const s = valid()
                    tamper(s)
                    await rejects(seal(rehash(s)), where)
                })
            }
        })

        it("active account slot after an inactive one", async () => {
            const s = raw([base({ to: c, receiverIndex: 3 })], [
                { account: a, balance: 1_000n, delta: -710n },
                null,
                null,
                { account: c, balance: 0n, delta: 700n },
            ])
            await rejects(s, "accountActive[j] * (1 - accountActive[j - 1]) === 0")
        })

        it("active transfer slot after an inactive one", async () => {
            const s = raw(
                [base({ amount: 100n }), null, base({ amount: 100n, nonce: 2n, salt: 22n })],
                [
                    { account: a, balance: 1_000n, delta: -220n },
                    { account: b, balance: 0n, delta: 200n },
                ],
            )
            await rejects(s, "transferActive[i] * (1 - transferActive[i - 1]) === 0")
        })

        it("no active transfer", async () => {
            await rejects(raw([], []), "transferActive[0] === 1")
        })

        it("active account that no transfer touches", async () => {
            const s = raw([base()], [
                { account: a, balance: 1_000n, delta: -710n },
                { account: b, balance: 0n, delta: 700n },
                { account: d, balance: 3n, delta: 0n },
            ])
            await rejects(s, "accountActive[j] * untouched[j].out === 0")
        })

        for (const index of [M, 31, 1_000_000]) {
            it(`sender index ${index} (not below M)`, async () => {
                const s = raw([base()], [
                    { account: a, balance: 1_000n, delta: -710n },
                    { account: b, balance: 0n, delta: 700n },
                ])
                s.senderIndex[0] = BigInt(index)
                await rejects(seal(s), "senderSel[i].enable <==")
            })
        }

        it("receiver index p - 1", async () => {
            const s = raw([base()], [
                { account: a, balance: 1_000n, delta: -710n },
                { account: b, balance: 0n, delta: 700n },
            ])
            s.receiverIndex[0] = P - 1n
            await rejects(seal(s), "receiverSel[i].enable <==")
        })

        it("receiver index pointing at an inactive slot", async () => {
            // The zero account with amount 0: limbs and balances all agree with
            // the empty slot, only its inactivity rejects it.
            await rejects(
                raw([base({ to: ZERO, amount: 0n, receiverIndex: 1 })], [{ account: a, balance: 1_000n, delta: -10n }]),
                "receiverActive[i].out === transferActive[i]",
            )
        })

        it("sender index pointing at an inactive slot", async () => {
            await rejects(
                raw([base({ signer: ZERO, to: a, amount: 0n, fee: 0n, senderIndex: 1, receiverIndex: 0 })], [
                    { account: a, balance: 1_000n, delta: 0n },
                ]),
                "senderActive[i].out === transferActive[i]",
            )
        })

        it("commitments hashed in another order", async () => {
            const s = fromBatch(fixtureBatch)
            const swapped = [1, 0, ...Array.from({ length: N - 2 }, (_, i) => i + 2)]
            await rejects(seal(rehash(s, swapped)), "batchHash.out === commitmentsHash")
        })

        it("a commitment opened to another amount", async () => {
            const s = fromBatch(fixtureBatch)
            const hash = s.commitmentsHash[0]
            s.amount[0] -= 1n
            s.deltaMagnitude[0] -= 1n
            s.deltaMagnitude[1] -= 1n
            s.commitmentsHash = [hash]
            await rejects(seal(s), "batchHash.out === commitmentsHash")
        })
    })
})
