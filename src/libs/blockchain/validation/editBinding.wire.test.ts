/**
 * Every transaction type an SDK client can build must pass the edit binding
 * exactly as a peer receives it, before and after osDenomination. The
 * transactions here come from the real SDK builders and the real signer, so
 * the edits are the ones the SDK generates and the amounts are in the wire
 * shape its serialiser emits. A type that fails here would be refused by
 * every node but the one that confirmed it.
 *
 * A few kinds have no public builder in the SDK; those are built with
 * `DemosTransactions.empty()` and the real signer from a hand-made payload,
 * and are marked as such.
 */

import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"

mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: async () => 100 },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: () => {},
        only: () => {},
    },
}))

import { DemosTokens, DemosTransactions, prepareXMPayload, prepareXMScript } from "@kynesyslabs/demosdk/websdk"
import { Identities } from "@kynesyslabs/demosdk/abstraction"
import { StorageProgram } from "@kynesyslabs/demosdk/storage"
import { escrow } from "@kynesyslabs/demosdk"
import { D402Client } from "@kynesyslabs/demosdk/d402/client"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import { verifyAdmissionEdits, verifyEditsAtApply } from "./editBinding"
import { OS, PEER, chainIs, demos, handMade, onTheWire, viaConfirm } from "./editBinding.fixtures"

const identities = new Identities()

const storage = StorageProgram.createStorageProgram(
    demos.getAddress(),
    "probe",
    { hello: "world" },
    "json",
    undefined,
    { nonce: 1 },
)
const storageAddress = storage.storageAddress

const proofUrl = "https://gist.github.com/someone/abc123"
const evmIdentity = {
    target_identity: {
        chain: "evm",
        subchain: "mainnet",
        isEVM: true,
        chainId: 1,
        targetAddress: "0x" + "ee".repeat(20),
        signature: "0x" + "12".repeat(65),
        signedData: "demos:link",
        publicKey: "0x" + "34".repeat(33),
        timestamp: 1,
    },
}
const telegramProof = {
    payload: {
        telegram_user_id: "42",
        username: "alice",
        public_key: "0x" + "aa".repeat(32),
        timestamp: 1,
    },
    signature: "0x" + "bb".repeat(64),
}

type Case = [name: string, build: () => Promise<Transaction>, needsPostFork?: boolean]

const cases: Case[] = [
    ["native send", () => DemosTransactions.pay(PEER, 3n * OS, demos)],
    [
        "native tlsn_request",
        async () => {
            const { TLSNotaryService: Service } = await import("@kynesyslabs/demosdk/tlsnotary/service")
            return (Service.prototype as any).createTlsnRequestTransaction.call(
                { demos },
                "https://api.github.com/user",
            )
        },
    ],
    [
        "native tlsn_store",
        async () => {
            const { TLSNotaryService: Service } = await import("@kynesyslabs/demosdk/tlsnotary/service")
            return (Service.prototype as any).createTlsnStoreTransaction.call(
                { demos },
                "token-1",
                "proof-bytes",
                "onchain",
                2n * OS,
            )
        },
    ],
    ["identity xm add", () => viaConfirm(() => identities.inferXmIdentity(demos, evmIdentity as never, "ref1"))],
    [
        "identity xm remove",
        () =>
            viaConfirm(() =>
                identities.removeXmIdentity(demos, {
                    chain: "evm",
                    subchain: "mainnet",
                    address: "0x" + "ee".repeat(20),
                } as never),
            ),
    ],
    [
        "identity web2 add (github)",
        () =>
            viaConfirm(() =>
                identities.inferWeb2Identity(demos, {
                    context: "github",
                    proof: proofUrl,
                    username: "someone",
                    userId: "99",
                    referralCode: null,
                } as never),
            ),
    ],
    [
        "identity web2 remove",
        () =>
            viaConfirm(() =>
                identities.removeWeb2Identity(demos, { context: "github", username: "someone" } as never),
            ),
    ],
    [
        "identity web2 add (telegram, signed by the bot for the user)",
        () =>
            viaConfirm(() =>
                identities.inferWeb2Identity(demos, {
                    context: "telegram",
                    proof: telegramProof,
                    username: "alice",
                    userId: "42",
                } as never),
            ),
    ],
    [
        "identity pqc add",
        () =>
            viaConfirm(() =>
                (identities as any).inferIdentity(demos, "pqc" as never, [
                    { algorithm: "falcon", address: "0x" + "55".repeat(32), signature: "0x01" },
                ] as never),
            ),
    ],
    [
        "identity ud add",
        () =>
            viaConfirm(() =>
                (identities as any).inferIdentity(demos, "ud" as never, {
                    domain: "alice.crypto",
                    signingAddress: "0x" + "ee".repeat(20),
                    signature: "0x02",
                } as never),
            ),
    ],
    [
        "identity nomis add",
        () => viaConfirm(() => identities.addNomisIdentity(demos, { chain: "evm", subchain: "mainnet", address: "0x1" } as never)),
    ],
    [
        "identity humanpassport add",
        () => viaConfirm(() => identities.addHumanPassportIdentity(demos, { address: "0x1", referralCode: null } as never)),
    ],
    [
        "identity ethos add",
        () => viaConfirm(() => identities.addEthosIdentity(demos, { chain: "evm", subchain: "mainnet", address: "0x" + "ee".repeat(20), score: 1, lastSyncedAt: "2026-01-01T00:00:00.000Z" } as never)),
    ],
    [
        "identity tlsn add",
        () =>
            viaConfirm(() =>
                identities.addWeb2IdentityViaTLSN(demos, "github", { pres: "x" } as never, "h", [[0, 1]] as never, "r" as never, "someone", 99, null),
            ),
    ],
    // No public builder for zk identity edits in this SDK: hand-made payload.
    [
        "identity zk commitment add (hand-made payload)",
        () => handMade("identity", { context: "zk", method: "zk_commitmentadd", payload: [{ commitment: "c1", provider: "github" }] }),
    ],
    [
        "identity zk attestation add (hand-made payload)",
        () => handMade("identity", { context: "zk", method: "zk_attestationadd", payload: [{ nullifier: "n1", proof: "p" }] }),
    ],
    [
        "web2Request (hand-made payload, shape of the SDK's proxy call)",
        () =>
            handMade("web2Request", {
                message: { sessionId: "s", payload: "", authorization: "", web2Request: { raw: { url: "https://a.b" } } },
            }),
    ],
    [
        "crosschainOperation",
        async () =>
            prepareXMPayload(
                prepareXMScript({
                    chain: "eth",
                    subchain: "sepolia",
                    signedPayloads: ["0xdead"],
                    type: "pay",
                } as never),
                demos,
            ),
    ],
    ["storageProgram create", () => demos.storagePrograms.sign(storage)],
    [
        "storageProgram write",
        () => demos.storagePrograms.sign(StorageProgram.writeStorage(storageAddress, { hello: "again" }, "json")),
    ],
    [
        "storageProgram access control",
        () => demos.storagePrograms.sign(StorageProgram.updateAccessControl(storageAddress, StorageProgram.publicACL())),
    ],
    [
        "storageProgram delete",
        () => demos.storagePrograms.sign(StorageProgram.deleteStorageProgram(storageAddress)),
    ],
    ["storage", () => DemosTransactions.store(new Uint8Array([1, 2, 3]), demos)],
    ["l2ps_hash_update", () => DemosTransactions.createL2PSHashUpdate("l2ps-1", "0x" + "ab".repeat(32), 4, demos)],
    ["validatorStake", () => DemosTransactions.stake("5000000000", "https://node.example", demos)],
    ["validatorUnstake", () => DemosTransactions.unstake(demos)],
    ["validatorExit", () => DemosTransactions.validatorExit(demos)],
    [
        "networkUpgrade",
        () =>
            DemosTransactions.proposeNetworkUpgrade(
                {
                    proposalId: "11111111-1111-4111-8111-111111111111",
                    proposedParameters: { networkFee: 2 } as never,
                    rationale: "raise the fee",
                    effectiveAtBlock: 5000,
                },
                demos,
            ),
    ],
    [
        "networkUpgradeVote",
        () => DemosTransactions.voteOnUpgrade("11111111-1111-4111-8111-111111111111", true, demos),
    ],
    [
        "demoswork (hand-made payload)",
        () => handMade("demoswork", { operationOrder: [], operations: {}, steps: {} }),
    ],
    [
        "escrow",
        () => escrow.EscrowTransaction.sendToIdentity(demos, "twitter", "@bob", 5n * OS, { expiryDays: 30, message: "hi" }),
    ],
    [
        "d402_payment",
        async () => {
            const client = new D402Client(demos)
            const unsigned = await client.createPayment({
                recipient: PEER,
                amount: "2000000000",
                resourceId: "res-1",
                description: "d",
            } as never)
            return demos.sign(unsigned)
        },
    ],
    // The builders return the transaction addressed to a 40-hex token address,
    // which the signer refuses, so the recipient is set to an account first.
    [
        "tokenCreation",
        async () => {
            const tx = await new DemosTokens(demos).createToken({
                name: "T",
                ticker: "TT",
                decimals: 6,
                initialSupply: "1000",
            } as never)
            tx.content.to = PEER
            return demos.sign(tx)
        },
    ],
    [
        "tokenExecution",
        async () => {
            const tx = await new DemosTokens(demos).transfer("0x" + "ab".repeat(20), PEER, "10")
            tx.content.to = PEER
            return demos.sign(tx)
        },
    ],
    [
        "contractDeploy (hand-made payload)",
        () => handMade("contractDeploy", { source: "contract C {}", constructorArgs: [] }),
    ],
    [
        "contractCall (hand-made payload)",
        () => handMade("contractCall", { contractAddress: PEER, method: "get", args: [] }),
    ],
    [
        "atomicWork",
        () =>
            DemosTransactions.atomicWork(
                {
                    intent: { profile: "p" },
                    authorizations: [],
                    edits: [{ type: "work-attempt", workId: "w", attemptId: "a", canonicalBytesHash: "h" }],
                    transfers: [{ to: PEER, amount: "25" }],
                } as never,
                demos,
            ),
        true,
    ],
]

describe("edit binding on transactions built by the SDK, as received", () => {
    beforeAll(() => {
        getSharedState.lastBlockNumber = 100
    })

    for (const post of [true, false]) {
        describe(post ? "after osDenomination" : "before osDenomination", () => {
            beforeEach(() => chainIs(post))

            for (const [name, build, needsPostFork] of cases) {
                if (needsPostFork && !post) continue

                it(`${name}: admitted and applied`, async () => {
                    const tx = onTheWire(await build())
                    expect(tx.content.gcr_edits.length).toBeGreaterThan(0)

                    expect(await verifyAdmissionEdits(tx)).toEqual({ ok: true })
                    expect(await verifyEditsAtApply(tx)).toEqual({ ok: true })
                })
            }
        })
    }
})
