import { describe, it, expect } from "bun:test"
import bs58 from "bs58"
import { WalletContractV4, WalletContractV5R1 } from "@ton/ton"
import {
    XM_PROOF_MAX_AGE_MS,
    checkAddressDerivedFromKey,
    checkXmDisplayAddress,
    checkXmSignedData,
    xmBoundProofMessage,
} from "./xmProof"
import {
    aptosFixture,
    ibcFixture,
    nearFixture,
    tonFixture,
    xrplFixture,
    type ChainFixture,
} from "./xmProof.fixtures"

const SENDER = "0x" + "AB".repeat(32)
const NOW = 1_800_000_000_000

describe("xmBoundProofMessage", () => {
    it("names chain, address, sender and issuance", () => {
        expect(
            xmBoundProofMessage("xrpl", "rAbC", SENDER, NOW),
        ).toBe(`demos-xm:v1:xrpl:rAbC:${SENDER.toLowerCase()}:${NOW}`)
    })

    it("folds the case of evm and aptos addresses only", () => {
        expect(xmBoundProofMessage("evm", "0xAbC", SENDER, 1)).toContain(
            ":0xabc:",
        )
        expect(xmBoundProofMessage("aptos", "0xAbC", SENDER, 1)).toContain(
            ":0xabc:",
        )
        expect(xmBoundProofMessage("solana", "AbC", SENDER, 1)).toContain(
            ":AbC:",
        )
    })
})

describe("checkXmSignedData", () => {
    const base = {
        chain: "solana",
        targetAddress: "So1anaAddressXyz",
        sender: SENDER,
        now: NOW,
    }
    const signed = (issuedAt: number) =>
        xmBoundProofMessage(base.chain, base.targetAddress, SENDER, issuedAt)

    it("accepts the canonical message issued just now", () => {
        expect(checkXmSignedData({ ...base, signedData: signed(NOW - 1000) }))
            .toEqual({ ok: true })
    })

    it("refuses the legacy text (the sender's own address)", () => {
        const r = checkXmSignedData({ ...base, signedData: SENDER })
        expect(r.ok).toBe(false)
    })

    it("refuses an old signature by the wallet, such as a login message", () => {
        const r = checkXmSignedData({
            ...base,
            signedData: "Sign in to example.org\nnonce: 12345",
        })
        expect(r.ok).toBe(false)
    })

    it("refuses a proof older than the window", () => {
        const r = checkXmSignedData({
            ...base,
            signedData: signed(NOW - XM_PROOF_MAX_AGE_MS - 1),
        })
        expect(r).toEqual({
            ok: false,
            message: "xm proof is too old, sign a new one",
        })
    })

    it("accepts a proof right at the window edge", () => {
        expect(
            checkXmSignedData({
                ...base,
                signedData: signed(NOW - XM_PROOF_MAX_AGE_MS),
            }).ok,
        ).toBe(true)
    })

    it("refuses a proof issued in the future", () => {
        expect(
            checkXmSignedData({ ...base, signedData: signed(NOW + 5 * 60_000) })
                .ok,
        ).toBe(false)
    })

    it("refuses a proof made for another Demos account", () => {
        const other = xmBoundProofMessage(
            base.chain,
            base.targetAddress,
            "0x" + "cd".repeat(32),
            NOW,
        )
        expect(checkXmSignedData({ ...base, signedData: other }).ok).toBe(false)
    })

    it("refuses a proof made for another address or chain", () => {
        const otherAddress = xmBoundProofMessage(base.chain, "Other", SENDER, NOW)
        const otherChain = xmBoundProofMessage("evm", base.targetAddress, SENDER, NOW)
        expect(checkXmSignedData({ ...base, signedData: otherAddress }).ok).toBe(false)
        expect(checkXmSignedData({ ...base, signedData: otherChain }).ok).toBe(false)
    })

    it("refuses a non-numeric issuedAt", () => {
        const text = `demos-xm:v1:solana:${base.targetAddress}:${SENDER.toLowerCase()}:soon`
        expect(checkXmSignedData({ ...base, signedData: text }).ok).toBe(false)
    })
})

describe("checkXmDisplayAddress", () => {
    it("accepts an absent displayAddress", () => {
        expect(checkXmDisplayAddress("evm", "0xabc", undefined).ok).toBe(true)
        expect(checkXmDisplayAddress("evm", "0xabc", null).ok).toBe(true)
    })

    it("accepts the same address, ignoring case on evm", () => {
        expect(checkXmDisplayAddress("evm", "0xabc", "0xABC").ok).toBe(true)
    })

    it("refuses a different address", () => {
        expect(checkXmDisplayAddress("evm", "0xabc", "0xdef").ok).toBe(false)
    })

    it("is case-sensitive where the address format is", () => {
        expect(checkXmDisplayAddress("solana", "AbC", "abc").ok).toBe(false)
        expect(checkXmDisplayAddress("xrpl", "rAbC", "rabc").ok).toBe(false)
    })

    it("refuses an empty string as a different address", () => {
        expect(checkXmDisplayAddress("evm", "0xabc", "").ok).toBe(false)
    })
})

describe("checkAddressDerivedFromKey", () => {
    async function cases(): Promise<ChainFixture[]> {
        return [
            xrplFixture("ed25519"),
            xrplFixture("ecdsa-secp256k1"),
            tonFixture(),
            tonFixture("testnet"),
            await ibcFixture("atom", "cosmos"),
            await ibcFixture("ibc", "osmo"),
            nearFixture(),
            aptosFixture(),
        ]
    }

    it("accepts the address that the key controls, on every chain", async () => {
        for (const f of await cases()) {
            const r = checkAddressDerivedFromKey({
                chain: f.chain,
                subchain: f.subchain,
                publicKey: f.publicKey,
                targetAddress: f.targetAddress,
            })
            expect({ chain: f.chain, r }).toEqual({ chain: f.chain, r: { ok: true } })
        }
    })

    it("refuses another account's address for a key the signer owns", async () => {
        const victim: Record<string, ChainFixture> = {
            xrpl: xrplFixture("ed25519"),
            ton: tonFixture(),
            atom: await ibcFixture("atom", "cosmos", 21),
            ibc: await ibcFixture("ibc", "osmo", 22),
            near: nearFixture(),
            aptos: aptosFixture(),
        }
        const attackers: ChainFixture[] = [
            xrplFixture("ed25519"),
            { ...tonFixture(), ...{ publicKey: "07".repeat(32) } },
            await ibcFixture("atom", "cosmos", 31),
            await ibcFixture("ibc", "osmo", 32),
            { ...nearFixture(), publicKey: `ed25519:${bs58.encode(new Uint8Array(32).fill(8))}` },
            { ...aptosFixture(), publicKey: "0x" + "09".repeat(32) },
        ]
        for (const attacker of attackers) {
            const r = checkAddressDerivedFromKey({
                chain: attacker.chain,
                subchain: "mainnet",
                publicKey: attacker.publicKey,
                targetAddress: victim[attacker.chain].targetAddress,
            })
            expect({ chain: attacker.chain, ok: r.ok }).toEqual({
                chain: attacker.chain,
                ok: false,
            })
        }
    })

    it("refuses a missing or malformed key", () => {
        for (const chain of ["xrpl", "ton", "atom", "ibc", "near", "aptos"]) {
            expect(
                checkAddressDerivedFromKey({ chain, publicKey: undefined, targetAddress: "x" }).ok,
            ).toBe(false)
            expect(
                checkAddressDerivedFromKey({ chain, publicKey: "zz", targetAddress: "x" }).ok,
            ).toBe(false)
        }
    })

    it("derives the same TON wallet addresses as @ton/ton for v4r2 and v5r1", () => {
        for (let i = 1; i <= 8; i++) {
            const key = Buffer.alloc(32, i * 29)
            const v4 = WalletContractV4.create({ publicKey: key, workchain: 0 })
            const forms = (a: { toString: (o?: any) => string; toRawString: () => string }) => [
                a.toRawString(),
                a.toString(),
                a.toString({ urlSafe: true, bounceable: false }),
            ]
            for (const [subchain, networkGlobalId] of [
                ["mainnet", -239],
                ["testnet", -3],
            ] as const) {
                const v5 = WalletContractV5R1.create({
                    publicKey: key,
                    workchain: 0,
                    walletId: { networkGlobalId },
                })
                for (const target of [...forms(v4.address), ...forms(v5.address)]) {
                    expect(
                        checkAddressDerivedFromKey({
                            chain: "ton",
                            subchain,
                            publicKey: key.toString("hex"),
                            targetAddress: target,
                        }).ok,
                    ).toBe(true)
                }
            }
            const mainnetV5 = WalletContractV5R1.create({
                publicKey: key,
                workchain: 0,
                walletId: { networkGlobalId: -239 },
            })
            expect(
                checkAddressDerivedFromKey({
                    chain: "ton",
                    subchain: "testnet",
                    publicKey: key.toString("hex"),
                    targetAddress: mainnetV5.address.toString(),
                }).ok,
            ).toBe(false)
        }
    })

    it("refuses a NEAR named account, which a key cannot prove offline", () => {
        const f = nearFixture()
        const r = checkAddressDerivedFromKey({
            chain: "near",
            publicKey: f.publicKey,
            targetAddress: "alice.near",
        })
        expect(r.ok).toBe(false)
        expect((r as { message: string }).message).toContain("named accounts")
    })

    it("accepts a NEAR account given as the key string itself", () => {
        const f = nearFixture()
        expect(
            checkAddressDerivedFromKey({
                chain: "near",
                publicKey: f.publicKey,
                targetAddress: f.publicKey,
            }).ok,
        ).toBe(true)
    })

    it("refuses chains that have no key-bound proof here", () => {
        expect(
            checkAddressDerivedFromKey({ chain: "tron", publicKey: "00", targetAddress: "x" }).ok,
        ).toBe(false)
    })
})
