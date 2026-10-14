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

/** What an authenticated history read returns for one row's payload. */
export interface HistoryEntry {
    message: string | null
    content: Record<string, any> | null
}

function isContent(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Message and transaction content for one history row, from a single decrypt.
 *
 * Message order matters: an execution message is the node's own account of
 * what happened and wins over the payload, then any plaintext still on the
 * row, then the ciphertext. Content has no node-authored override, so it is
 * the plaintext on the row or the decrypted envelope. The envelope is
 * decrypted at most once and only when something still needs it. A row that
 * decrypts to nothing yields nulls rather than an error — one unreadable row
 * should not fail a page of history.
 */
export async function resolveHistoryEntry(
    row: HistoryRow,
    decrypt: EnvelopeDecryptor,
): Promise<HistoryEntry> {
    let decrypted: Promise<Record<string, any> | null> | null = null
    const readEnvelope = (): Promise<Record<string, any> | null> => {
        if (!row.encrypted_payload) return Promise.resolve(null)
        const envelope = row.encrypted_payload
        decrypted ??= Promise.resolve()
            .then(() => decrypt(envelope))
            .then(plain => (isContent(plain?.content) ? plain.content : null))
            .catch(error => {
                log.debug(
                    `[L2PS History] Could not decrypt a stored payload: ${error instanceof Error ? error.message : "unknown error"}`,
                )
                return null
            })
        return decrypted
    }

    const plaintext = isContent(row.content) ? row.content : null
    const content = plaintext ?? (await readEnvelope())

    const message =
        row.execution_message ||
        messageFromContent(plaintext) ||
        messageFromContent(await readEnvelope())

    return { message: message || null, content }
}

/** The message for one history row. */
export async function resolveHistoryMessage(
    row: HistoryRow,
    decrypt: EnvelopeDecryptor,
): Promise<string | null> {
    // Nothing else is wanted here, so do not decrypt just to fill content.
    if (row.execution_message) return row.execution_message
    return (await resolveHistoryEntry(row, decrypt)).message
}

/**
 * The transaction content for one history row, or null when it cannot be
 * read. Lets a member recover a structured payload — not just the message
 * string — that was sent to them through the subnet.
 */
export async function resolveHistoryContent(
    row: HistoryRow,
    decrypt: EnvelopeDecryptor,
): Promise<Record<string, any> | null> {
    return (await resolveHistoryEntry(row, decrypt)).content
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
    // loadL2PS throws for a subnet this node has no configuration for, and
    // the caller names the subnet, so an unknown or malformed name must end up
    // on the same no-key path as a missing key rather than fail the read.
    let instance: Awaited<ReturnType<typeof networks.loadL2PS>> | undefined
    try {
        instance =
            (await networks.getL2PS(l2psUid)) ?? (await networks.loadL2PS(l2psUid))
    } catch (error) {
        log.debug(
            `[L2PS History] Subnet ${JSON.stringify(l2psUid)} not available: ${error instanceof Error ? error.message : "unknown error"}`,
        )
    }

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
