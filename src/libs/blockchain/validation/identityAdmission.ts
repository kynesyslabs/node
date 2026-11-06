import type { Transaction } from "@kynesyslabs/demosdk/types"

/**
 * How long one identity transaction may spend on provider calls before it is
 * refused. The consensus mempool merge answers a peer within its call timeout
 * (10 s), so a slow provider must not hold the reply past it.
 */
export const IDENTITY_ADMISSION_TIMEOUT_MS = 5_000

export type IdentityAdmission = { ok: true } | { ok: false; reason: string }

/**
 * Where the transaction arrives from. "ingest" is gossip or RPC at an entry
 * node; "merge" is the consensus mempool merge between committee members.
 */
export type IdentityAdmissionMode = "ingest" | "merge"

/**
 * Identity kinds whose proof block application checks again by itself,
 * without the network. Admitting one of these unverified cannot store an
 * unproven claim: a bad proof fails at apply on every node alike.
 */
function proofRecheckedAtApply(tx: Transaction): boolean {
    const payload = tx.content?.data?.[1] as
        | { method?: string; payload?: { context?: string } }
        | undefined
    const method = payload?.method
    if (typeof method !== "string") return false
    if (method.endsWith("_identity_remove")) return true
    if (
        method === "tlsn_identity_assign" ||
        method === "zk_attestationadd" ||
        method === "zk_commitmentadd"
    ) {
        return true
    }
    return (
        method === "web2_identity_assign" &&
        payload.payload?.context === "telegram"
    )
}

/**
 * Runs the identity proof checks the RPC confirm path runs (signatures, web2
 * posts, provider scores) for a transaction reaching this node by gossip or by
 * the consensus mempool merge. Without it, a transaction pushed straight into
 * a peer's mempool skips every proof check, and block application stores
 * whatever the signed payload says.
 *
 * This is admission policy, not a consensus rule. Block application stays
 * free of network calls, so every node that applies a block writes the same
 * state. The cost is that nodes may disagree about admitting a transaction
 * while a provider is flapping, or after its score changed: a node holding
 * the transaction proposes a block the others do not build, which can cost a
 * round until the transaction leaves its mempool, but never splits state.
 *
 * Fails closed: an unreachable provider, a thrown error or the deadline
 * refuses the transaction. The one exception is the merge, for kinds whose
 * proof apply checks again: there a check that could not finish admits, so a
 * slow or overloaded member does not drop what the others keep. Kinds whose
 * claim apply stores as signed (provider scores, web2 posts) stay closed in
 * the merge too, since a provider outage an attacker can provoke would
 * otherwise let a forged claim through.
 */
export async function checkIdentityAdmission(
    tx: Transaction,
    timeoutMs = IDENTITY_ADMISSION_TIMEOUT_MS,
    mode: IdentityAdmissionMode = "ingest",
): Promise<IdentityAdmission> {
    if (tx.content?.type !== "identity") {
        return { ok: true }
    }

    // The validator already tied from_ed25519_address to the signature, so it
    // stands in for the authenticated request sender the RPC path uses.
    const sender = tx.content.from_ed25519_address
    if (typeof sender !== "string" || sender.length === 0) {
        return { ok: false, reason: "identity transaction has no ed25519 sender" }
    }

    const admitUnverified = mode === "merge" && proofRecheckedAtApply(tx)
    const unverifiable = (reason: string): IdentityAdmission =>
        admitUnverified ? { ok: true } : { ok: false, reason }

    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<IdentityAdmission>(resolve => {
        timer = setTimeout(
            () =>
                resolve(
                    unverifiable(
                        "identity proof could not be verified in time",
                    ),
                ),
            timeoutMs,
        )
    })

    const verify = async (): Promise<IdentityAdmission> => {
        try {
            // Loaded on demand: the handler pulls in every identity verifier,
            // which the mempool module should not load for other traffic.
            const { default: handleIdentityRequest } = await import(
                "@/libs/network/routines/transactions/handleIdentityRequest"
            )
            const result = await handleIdentityRequest(tx, sender)
            return result.success
                ? { ok: true }
                : { ok: false, reason: result.message }
        } catch (e) {
            return unverifiable(
                `identity proof verification error: ${e instanceof Error ? e.message : String(e)}`,
            )
        }
    }

    try {
        return await Promise.race([verify(), deadline])
    } finally {
        clearTimeout(timer)
    }
}
