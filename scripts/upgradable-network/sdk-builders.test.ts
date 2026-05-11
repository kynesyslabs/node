#!/usr/bin/env bun
/**
 * SDK-builder contract smoke-test — Phase 0 / Phase 1 (upgradable_network).
 *
 * Exercises the REAL `@kynesyslabs/demosdk` through builder + sign(). This
 * is the layer where the "Invalid To address: 0x" regression hid: jest
 * unit tests hand-crafted tx objects and never called the builders, so a
 * bug in the builder output (missing `tx.content.to`) slipped past a green
 * suite. Running this on CI guards against that class of bug.
 *
 * Usage:  bun scripts/test-sdk-builders.ts
 * Exits 0 on success, 1 with a diff on any failed invariant. No node/RPC
 * required — getAddressNonce is stubbed.
 */

import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"

const FIXED_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"

let failures = 0
function check(label: string, cond: unknown, detail?: unknown) {
    if (cond) {
        console.log(`  ✓ ${label}`)
    } else {
        failures++
        console.error(`  ✗ ${label}`)
        if (detail !== undefined) {
            console.error(`      ${JSON.stringify(detail)}`)
        }
    }
}

async function makeDemos() {
    const demos = new Demos()
    await demos.connectWallet(FIXED_MNEMONIC)
    // Short-circuit the nodeCall the builders make before signing.
    ;(demos as unknown as { getAddressNonce: unknown }).getAddressNonce =
        async () => 0
    return demos
}

async function ownerHex(demos: Demos) {
    const { publicKey } = await demos.crypto.getIdentity("ed25519")
    return uint8ArrayToHex(publicKey as Uint8Array)
}

function assertShape(
    section: string,
    tx: any,
    type: string,
    owner: string,
) {
    console.log(section)
    check("tx.content.type matches", tx?.content?.type === type, tx?.content?.type)
    check(
        "data tuple [type, payload]",
        Array.isArray(tx?.content?.data) && tx.content.data[0] === type,
        tx?.content?.data,
    )
    const to = tx?.content?.to ?? ""
    check(
        "content.to is 0x-prefixed 64-hex",
        /^0x[0-9a-f]{64}$/i.test(to),
        to,
    )
    const from = tx?.content?.from_ed25519_address ?? ""
    const stripPrefix = (s: string) => s.replace(/^0x/, "")
    check(
        "content.from_ed25519_address matches wallet",
        stripPrefix(from) === stripPrefix(owner),
        { from, owner },
    )
    check("content.to === from_ed25519_address (reflexive)", to === from, {
        to,
        from,
    })
    check("hash populated", Boolean(tx?.hash))
    check("signature populated", Boolean(tx?.signature))
}

async function main() {
    const demos = await makeDemos()
    const owner = await ownerHex(demos)

    // ---------- Staking (Batch 1) ----------
    {
        const tx = await DemosTransactions.stake(
            "10000000000000000000000000",
            "https://v.example",
            demos,
        )
        assertShape("stake()", tx, "validatorStake", owner)
        const p = (tx?.content?.data?.[1] ?? {}) as any
        check(
            "stake payload amount+connectionUrl",
            p.amount === "10000000000000000000000000" &&
                p.connectionUrl === "https://v.example",
            p,
        )
    }
    {
        const tx = await DemosTransactions.unstake(demos)
        assertShape("unstake()", tx, "validatorUnstake", owner)
        const p = (tx?.content?.data?.[1] ?? {}) as any
        check(
            "unstake payload is empty object",
            JSON.stringify(p) === "{}",
            p,
        )
    }
    {
        const tx = await DemosTransactions.validatorExit(demos)
        assertShape("validatorExit()", tx, "validatorExit", owner)
    }

    // ---------- Governance (Batch 2) ----------
    {
        const proposalId = "00000000-0000-0000-0000-000000000001"
        const tx = await DemosTransactions.proposeNetworkUpgrade(
            {
                proposalId,
                proposedParameters: { networkFee: 12 },
                rationale: "smoke",
                effectiveAtBlock: 1000,
            },
            demos,
        )
        assertShape("proposeNetworkUpgrade()", tx, "networkUpgrade", owner)
        const p = (tx?.content?.data?.[1] ?? {}) as any
        check(
            "proposal payload propagated",
            p.proposalId === proposalId &&
                p.proposedParameters?.networkFee === 12 &&
                p.rationale === "smoke" &&
                p.effectiveAtBlock === 1000,
            p,
        )
    }
    {
        const proposalId = "00000000-0000-0000-0000-000000000002"
        const tx = await DemosTransactions.voteOnUpgrade(
            proposalId,
            true,
            demos,
        )
        assertShape("voteOnUpgrade()", tx, "networkUpgradeVote", owner)
        const p = (tx?.content?.data?.[1] ?? {}) as any
        check(
            "vote payload (proposalId + approve)",
            p.proposalId === proposalId && p.approve === true,
            p,
        )
    }

    console.log()
    if (failures > 0) {
        console.error(`❌ ${failures} check(s) failed`)
        process.exit(1)
    }
    console.log("✅ All SDK builder contracts pass")
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
