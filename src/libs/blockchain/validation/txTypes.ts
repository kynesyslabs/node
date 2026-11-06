/**
 * The transaction types the node accepts, and who may author each.
 *
 * The SDK gives a transaction of any type the universal gas and nonce edits,
 * and the edit binding only checks that the shipped edits are the generated
 * ones. A type the node has no handler for therefore passed every check and
 * was applied as a fee and a nonce, its own effect silently dropped: an
 * escrow deposit, a contract or a token that never exists. This list is the
 * one place that says which types are implemented.
 */

import type { Transaction } from "@kynesyslabs/demosdk/types"

/**
 * Types a client may submit over RPC and a peer may gossip. Each one either
 * has a handler in the node or is carried in full by the edits regenerated
 * from its signed body. Escrow, contract, token and ipfs transactions are
 * not here: the node has no implementation for them.
 */
export const CLIENT_TX_TYPES: ReadonlySet<string> = new Set([
    "native",
    "web2Request",
    "crosschainOperation",
    "demoswork",
    "identity",
    "nativeBridge",
    "l2psEncryptedTx",
    "subnet",
    "l2ps_hash_update",
    "storage",
    "storageProgram",
    "d402_payment",
    "validatorStake",
    "validatorUnstake",
    "validatorExit",
    "networkUpgrade",
    "networkUpgradeVote",
    "atomicWork",
])

/**
 * Types only a node authors: the genesis block, L2PS batches and the
 * messages the signalling server stores. They enter the authoring node's own
 * pool directly and reach peers through the consensus merge and in blocks,
 * never through RPC or gossip.
 */
export const NODE_TX_TYPES: ReadonlySet<string> = new Set([
    "genesis",
    "l2psBatch",
    "instantMessaging",
])

/** Every type a block may carry. */
export const BLOCK_TX_TYPES: ReadonlySet<string> = new Set([
    ...CLIENT_TX_TYPES,
    ...NODE_TX_TYPES,
])

type TxView = Pick<Transaction, "content"> | { content?: unknown }

function typeOf(tx: TxView): unknown {
    const content = (tx as { content?: unknown }).content
    return content && typeof content === "object"
        ? (content as Record<string, unknown>).type
        : undefined
}

function notAccepted(type: unknown): string {
    return `transaction type ${JSON.stringify(type ?? null)} is not accepted`
}

/**
 * Why a transaction submitted over RPC or received over gossip is refused for
 * its type, or null. A local policy of the node that first sees it, so it
 * needs no fork.
 */
export function clientTxTypeRefusal(tx: TxView): string | null {
    const type = typeOf(tx)
    if (typeof type === "string" && CLIENT_TX_TYPES.has(type)) return null
    if (typeof type === "string" && NODE_TX_TYPES.has(type)) {
        return `${type} transactions are authored by nodes only`
    }
    return notAccepted(type)
}

/**
 * Why a block, or the consensus merge that fills one, refuses a transaction
 * for its type, or null. Applied under the `txTypeAllowList` fork.
 */
export function blockTxTypeRefusal(tx: TxView): string | null {
    const type = typeOf(tx)
    return typeof type === "string" && BLOCK_TX_TYPES.has(type)
        ? null
        : notAccepted(type)
}

/**
 * A message the signalling server stores: an `instantMessaging` transaction
 * with no edits, so it pays no fee and spends no nonce.
 */
export function isNodeMessage(tx: TxView): boolean {
    if (typeOf(tx) !== "instantMessaging") return false
    const edits = ((tx as { content?: Record<string, unknown> }).content ?? {})
        .gcr_edits
    return !Array.isArray(edits) || edits.length === 0
}

/** A public key as validator rows and signer fields compare: lower-case, 0x-prefixed. */
function keyOf(value: unknown): string | null {
    if (typeof value !== "string" || value.length === 0) return null
    const lower = value.toLowerCase()
    return lower.startsWith("0x") ? lower : `0x${lower}`
}

/**
 * Why a node message is refused under `instantMessagingBinding`, or null.
 * Its exemption from fee and nonce is for the node that relays the message,
 * so every signer field it names must be a validator staked at the tip
 * (`validators`, keys as `keyOf` gives them). A message that carries the
 * universal edits pays like any transaction and is not judged here.
 */
export function nodeMessageRefusal(
    tx: TxView,
    validators: ReadonlySet<string>,
): string | null {
    if (!isNodeMessage(tx)) return null
    const content = ((tx as { content?: unknown }).content ?? {}) as Record<
        string,
        unknown
    >
    const signers = [content.from, content.from_ed25519_address]
        .filter(s => s !== undefined && s !== null && s !== "")
        .map(keyOf)
    if (signers.length === 0 || signers.some(s => s === null || !validators.has(s))) {
        return "an instantMessaging transaction without edits must be signed by a staked validator"
    }
    return null
}

/** The keys of the validators staked at `tip`; a failed read throws. */
export async function validatorKeysAt(tip: number): Promise<Set<string>> {
    // Lazy: gcr.ts imports the edit binding, which imports this module.
    const { default: GCR } = await import("src/libs/blockchain/gcr/gcr")
    const rows = await GCR.getGCRValidatorsAtBlockOrThrow(tip)
    const keys = new Set<string>()
    for (const row of rows) {
        const key = keyOf(row.address)
        if (key) keys.add(key)
    }
    return keys
}
