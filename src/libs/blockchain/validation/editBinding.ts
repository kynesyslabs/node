/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * Binding of a transaction's shipped `gcr_edits` to the signed body, for every
 * transaction type.
 *
 * The signature proves who authored a transaction, not that the state changes
 * it carries are the ones its body implies. `handleGCR` applies the shipped
 * edits of any type as written, and nothing else in the pipeline re-derives
 * them: each committee member builds its candidate block from its own merged
 * pool and the committee only compares hashes. The edit set therefore has to
 * be bound where a transaction enters a pool and where a block applies it.
 *
 * Two entry points:
 *  - `verifyAdmissionEdits`: gossip ingest and the consensus mempool merge.
 *  - `verifyEditsAtApply`: the apply step.
 * Both are behind the `editBinding` fork. Inactive, admission keeps the
 * checks it had before the fork, so nodes on either side of a rollout admit
 * the same transactions and older clients keep working until the height.
 * Active, both run the same rule. The fork and the denomination shape are
 * judged from one source, the chain tip, so one call cannot straddle them.
 *
 * The comparison is exact and ordered, and it never reinterprets what a peer
 * shipped. Apply runs the shipped edits as they are, so a shipped amount is
 * compared in the shape it will be applied in: only the regenerated side is
 * brought to the wire shape, the one the SDK serialiser emits. Normalising
 * both sides would accept a DEM number where an OS string is expected, and the
 * balance routines would then apply it as that many OS.
 */

import type { GCREdit, Transaction } from "@kynesyslabs/demosdk/types"
import { denomination } from "@kynesyslabs/demosdk"

import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"
import { isForkActive } from "@/forks/forkGates"
import { getSharedState } from "@/utilities/sharedState"
import { carriesWorkEdits } from "@/libs/atomic-work/atomicApply"
import { generateGcrEdits } from "./generateGcrEdits"
import { verifyGcrEditsMatch, verifyNoUnexplainedValueEdits } from "./verifyGcrEdits"

export interface EditVerdict {
    ok: boolean
    reason?: string
}

const OK: EditVerdict = { ok: true }

function refuse(reason: string): EditVerdict {
    return { ok: false, reason }
}

/**
 * Node-authored transactions that never carry edits. They are not built with
 * the SDK, so regeneration would add the universal gas and nonce edits they
 * deliberately do not have; the rule for them is that they ship none, because
 * anything they shipped would be applied.
 */
const EDIT_FREE_TYPES = new Set<string>(["l2psBatch", "genesis"])

/**
 * The signalling server stores messages as `instantMessaging` transactions
 * signed by the node, with no edits. A client-signed one carries the universal
 * edits instead and is compared like any other type.
 */
const EDIT_FREE_OR_BOUND_TYPES = new Set<string>(["instantMessaging"])

/** JSON with object keys in code-unit order: key order is not part of an edit's meaning. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(v => canonical(v === undefined ? null : v)).join(",")}]`
    }
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        return `{${entries
            .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
            .join(",")}}`
    }
    return JSON.stringify(value) ?? "null"
}

/** The txhash is stamped on an edit when it is applied, so it is not part of what was signed. */
function blankTxhash(edits: GCREdit[]): GCREdit[] {
    return edits.map(e => ({ ...e, txhash: "" }) as GCREdit)
}

/**
 * Brings edits to the wire shape the SDK emits: OS strings once
 * osDenomination is active, DEM numbers before. Only the edits are passed to
 * the serialiser, so an unrelated malformed field of the transaction cannot
 * fail the comparison of its edits.
 */
function toWireShape(edits: GCREdit[], postFork: boolean): GCREdit[] {
    const serialised = denomination.serializeTransactionContent(
        { gcr_edits: edits } as never,
        postFork,
    )
    const parsed = JSON.parse(serialised) as { gcr_edits?: GCREdit[] }
    return parsed.gcr_edits ?? []
}

async function osDenominationActive(): Promise<boolean> {
    return isForkActive("osDenomination", await Chain.getLastBlockNumber())
}

/**
 * Whether edits are bound, and the denomination shape expected, from one read
 * of the chain tip (the source the native edit check always used for the
 * shape). A fork activating at height H binds the block applied on tip H,
 * which is block H + 1.
 */
export async function editBindingState(): Promise<{ active: boolean; postFork: boolean }> {
    const tip = await Chain.getLastBlockNumber()
    return {
        active: isForkActive("editBinding", tip),
        postFork: isForkActive("osDenomination", tip),
    }
}

/**
 * Why this node cannot create an award transaction that the network would
 * accept, or null. Once `editBinding` is active a peer drops an award not
 * signed by the genesis award signer, so a node signing with another key must
 * say so instead of reporting an award that never lands.
 */
export async function awardSignerProblem(): Promise<string | null> {
    if (!(await editBindingState()).active) return null
    const signer = getSharedState.genesisSudoPubkey
    if (!signer) return "genesis names no award signer, so no award is accepted"
    if (getSharedState.publicKeyHex?.toLowerCase() !== signer) {
        return "this node does not sign with the genesis award signer key"
    }
    return null
}

function senderOf(tx: Transaction): string {
    const content = tx.content as unknown as Record<string, unknown>
    const ed = content.from_ed25519_address
    if (typeof ed === "string" && ed.length > 0) return ed
    return typeof content.from === "string" ? content.from : ""
}

function isAwardPointsTx(tx: Transaction): boolean {
    const data = tx.content?.data as unknown
    return (
        (tx.content?.type as string) === "identity" &&
        Array.isArray(data) &&
        data[0] === "awardPoints"
    )
}

const AWARD_EDIT_KEYS = new Set([
    "type",
    "context",
    "isRollback",
    "operation",
    "account",
    "amount",
    "date",
    "txhash",
])

/**
 * The incentive award is the one transaction whose edits credit accounts that
 * are not the signer's, and its edits cannot be regenerated by the SDK: the
 * addresses were resolved from the node's own records when the award was
 * created and travel in the signed data. So the rule is explicit: it is
 * signed by the award signer committed in genesis, and its edits are exactly
 * one points credit per resolved account in its own data.
 *
 * The signer is read from block 0, never from node configuration, because apply
 * depends on it and every node must decide alike. A genesis that names none
 * accepts no award. The node that creates an award must sign with that key.
 */
function verifyAwardPoints(tx: Transaction): EditVerdict {
    const sudo = getSharedState.genesisSudoPubkey
    if (!sudo) return refuse("awardPoints: genesis names no award signer")

    const content = tx.content as unknown as Record<string, unknown>
    const signers = [content.from, content.from_ed25519_address]
    if (!signers.every(s => typeof s === "string" && s.toLowerCase() === sudo)) {
        return refuse("awardPoints: not signed by the genesis award signer")
    }

    const accounts = (tx.content.data as unknown as [string, unknown])[1]
    if (!Array.isArray(accounts)) {
        return refuse("awardPoints: data carries no account list")
    }
    const expected = accounts.filter(
        a => typeof a?.address === "string" && a.address.length > 0,
    ) as Array<{ address: string; points: unknown }>

    const shipped = (tx.content.gcr_edits ?? []) as unknown as Array<
        Record<string, unknown>
    >
    if (shipped.length !== expected.length) {
        return refuse(
            `awardPoints: ${shipped.length} edits for ${expected.length} resolved accounts`,
        )
    }

    let date: string | undefined
    for (let i = 0; i < expected.length; i++) {
        const edit = shipped[i]
        const points = Number(expected[i].points)
        if (!Number.isFinite(points) || points <= 0) {
            return refuse(`awardPoints: invalid points for ${expected[i].address}`)
        }
        if (Object.keys(edit).some(k => !AWARD_EDIT_KEYS.has(k))) {
            return refuse(`awardPoints: edit ${i} carries unexpected fields`)
        }
        if (
            edit.type !== "identity" ||
            edit.context !== "points" ||
            edit.operation !== "add" ||
            edit.isRollback !== false ||
            edit.account !== expected[i].address ||
            edit.amount !== points
        ) {
            return refuse(`awardPoints: edit ${i} is not the credit its data implies`)
        }
        // One award has one date; rollback finds its entries by it.
        const d = edit.date
        if (
            typeof d !== "string" ||
            Number.isNaN(Date.parse(d)) ||
            new Date(d).toISOString() !== d ||
            (date !== undefined && d !== date)
        ) {
            return refuse(`awardPoints: edit ${i} has an invalid or inconsistent date`)
        }
        date = d
    }
    return OK
}

/**
 * Compares the shipped edits with the ones the signed body implies, with the
 * explicit exceptions applied. `postFork` is the osDenomination state of the
 * chain tip; callers that check many transactions resolve it once.
 */
export async function verifyEditsAgainstBody(
    tx: Transaction,
    options: { postFork?: boolean } = {},
): Promise<EditVerdict> {
    if (isAwardPointsTx(tx)) return verifyAwardPoints(tx)

    const type = tx.content?.type as string
    const shippedRaw = (tx.content?.gcr_edits ?? []) as GCREdit[]
    if (EDIT_FREE_TYPES.has(type)) {
        return shippedRaw.length === 0
            ? OK
            : refuse(`${type} transactions carry no gcr_edits`)
    }
    if (EDIT_FREE_OR_BOUND_TYPES.has(type) && shippedRaw.length === 0) return OK

    let regenerated: GCREdit[]
    try {
        regenerated = await generateGcrEdits(tx)
    } catch (e) {
        return refuse(
            `gcr_edits cannot be regenerated: ${e instanceof Error ? e.message : String(e)}`,
        )
    }

    const postFork = options.postFork ?? (await osDenominationActive())
    // Copied, so nothing downstream observes a change made by this read-only check.
    const shipped = JSON.parse(JSON.stringify(shippedRaw)) as GCREdit[]
    const expected = toWireShape(blankTxhash(regenerated), postFork)

    if (canonical(blankTxhash(shipped)) !== canonical(expected)) {
        log.error(
            `[editBinding] tx ${tx.hash} (${type}) ships ${shipped.length} edits that differ from the ${expected.length} regenerated`,
        )
        return refuse("gcr_edits do not match regenerated set")
    }
    return OK
}

/**
 * Edits that act on one account must act on the sender's. The regenerated set
 * already says so for every SDK-built edit; this is the same rule stated
 * where the edit is applied, so an edit kind a future generator emits for
 * another account is refused until it is made an explicit exception.
 *
 * Exceptions: a Telegram identity link is signed by the bot and acts on the
 * user's account, which the user's own signature inside the proof vouches for.
 */
export function verifySenderBinding(tx: Transaction): EditVerdict {
    const sender = senderOf(tx)
    // Generation prefixes every account it names, but copies the sender into a
    // storage edit's context as it was signed.
    const account = sender !== "" && !sender.startsWith("0x") ? `0x${sender}` : sender
    const edits = (tx.content?.gcr_edits ?? []) as unknown as Array<
        Record<string, unknown>
    >

    for (const edit of edits) {
        const type = String(edit.type)
        switch (type) {
            case "nonce":
            case "networkUpgrade":
            case "networkUpgradeVote":
            case "validatorStake":
            case "tlsnotary":
                if (account === "" || edit.account !== account) {
                    return refuse(`${type} edit acts on another account than the sender`)
                }
                break
            case "identity": {
                const data = edit.data as { context?: unknown } | null | undefined
                const telegramLink =
                    edit.context === "web2" &&
                    edit.operation === "add" &&
                    data?.context === "telegram"
                if (!telegramLink && (account === "" || edit.account !== account)) {
                    return refuse("identity edit acts on another account than the sender")
                }
                break
            }
            case "storageProgram": {
                const context = edit.context as { sender?: unknown } | undefined
                if (sender === "" || context?.sender !== sender) {
                    return refuse("storageProgram edit names another sender than the signer")
                }
                break
            }
        }
    }
    return OK
}

/**
 * The check a block applies before it applies a transaction (behind the
 * `editBinding` fork): the edits are the regenerated ones and each acts on
 * the sender's own account. The award transaction has its own rule.
 */
export async function verifyEditsAtApply(
    tx: Transaction,
    options: { postFork?: boolean } = {},
): Promise<EditVerdict> {
    const bound = await verifyEditsAgainstBody(tx, options)
    if (!bound.ok || isAwardPointsTx(tx)) return bound
    return verifySenderBinding(tx)
}

/**
 * The check at gossip ingest and consensus merge.
 *
 * Active: the rule apply uses, for every type including native and Work, so a
 * tx admitted here is one apply accepts, and the other way round. Fee edits are
 * derived at apply, so neither side of the comparison carries them, and a
 * Work's edits are the ones the node derives from its payload, which refuses
 * an invalid one.
 *
 * Inactive: exactly what admission checked before the fork. Native and Work
 * keep the whole-set match, every other type the value-edit projection.
 *
 * Fails closed: a transaction that cannot be checked is refused.
 */
export async function verifyAdmissionEdits(tx: Transaction): Promise<EditVerdict> {
    try {
        const { active, postFork } = await editBindingState()
        if (active) return await verifyEditsAtApply(tx, { postFork })

        if (tx.content?.type === "native" || carriesWorkEdits(tx)) {
            const { match } = await verifyGcrEditsMatch(tx, { expectFeeEdits: false })
            return match ? OK : refuse("gcr_edits do not match regenerated set")
        }
        const { ok, unexplained } = await verifyNoUnexplainedValueEdits(tx)
        return ok
            ? OK
            : refuse(
                  `value edits with no counterpart in the regenerated set (${unexplained.join(", ")})`,
              )
    } catch (e) {
        return refuse(
            `gcr_edits verification error: ${e instanceof Error ? e.message : String(e)}`,
        )
    }
}
