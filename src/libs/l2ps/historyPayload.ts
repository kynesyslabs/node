/**
 * Reading a message back out of L2PS history.
 *
 * History rows keep the transaction as ciphertext, so the message a client
 * asks for is not sitting in a column any more — it has to be decrypted with
 * the subnet key when an authenticated read comes in. Rows written before
 * that change still carry `content` in the clear, and a node configured with
 * `l2ps.historyStorePlaintext` still writes it, so both paths stay supported.
 *
 * The decryptor is injected rather than imported so this stays independent of
 * the subnet registry, which needs a running node to resolve anything.
 */

import log from "@/utilities/logger"

export interface HistoryRow {
    encrypted_payload?: Record<string, any> | null
    content?: Record<string, any> | null
    execution_message?: string | null
}

/** Decrypts one stored envelope, or returns null if it cannot. */
export type EnvelopeDecryptor = (
    envelope: Record<string, any>,
) => Promise<Record<string, any> | null>

/** The message carried by a transaction payload, if it has one. */
export function messageFromContent(
    content: Record<string, any> | null | undefined,
): string | null {
    const message = content?.data?.[1]?.message
    return typeof message === "string" && message.length > 0 ? message : null
}

/**
 * The message for one history row.
 *
 * Order matters: an execution message is the node's own account of what
 * happened and wins over the payload, then any plaintext still on the row,
 * then the ciphertext. A row that decrypts to nothing yields null rather
 * than an error — one unreadable row should not fail a page of history.
 */
export async function resolveHistoryMessage(
    row: HistoryRow,
    decrypt: EnvelopeDecryptor,
): Promise<string | null> {
    if (row.execution_message) return row.execution_message

    const fromPlaintext = messageFromContent(row.content)
    if (fromPlaintext) return fromPlaintext

    if (!row.encrypted_payload) return null

    try {
        const decrypted = await decrypt(row.encrypted_payload)
        return messageFromContent(decrypted?.content)
    } catch (error) {
        log.debug(
            `[L2PS History] Could not decrypt a stored payload: ${error instanceof Error ? error.message : "unknown error"}`,
        )
        return null
    }
}

/**
 * A decryptor backed by the subnet the node has joined.
 *
 * Returns a decryptor that always yields null when the subnet is unknown to
 * this node, so a read from a node outside the subnet degrades to metadata
 * instead of failing.
 */
export async function subnetDecryptor(
    l2psUid: string,
): Promise<EnvelopeDecryptor> {
    const { default: ParallelNetworks } = await import(
        "@/libs/l2ps/parallelNetworks"
    )
    const networks = ParallelNetworks.getInstance()
    const instance =
        (await networks.getL2PS(l2psUid)) ?? (await networks.loadL2PS(l2psUid))

    if (!instance) {
        log.debug(`[L2PS History] No key for subnet ${l2psUid}`)
        return async () => null
    }

    return async envelope =>
        (await instance.decryptTx(envelope as any)) as unknown as Record<
            string,
            any
        > | null
}
