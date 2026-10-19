import {
    assertStorageWriteAllowed,
    ATOMIC_STORAGE_DOMAIN,
    deriveStorageAddress,
    storageValueDigest,
    StorageWriteError,
} from "@/libs/atomic-work/storageWrite"
import { jcsCanonicalize } from "@/libs/crypto/jcs"
import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"

/** Same ceiling as an ordinary storage program. */
const MAX_VALUE_BYTES = 1048576

export interface StoragePutEdit {
    type: "storage-program-put"
    isRollback?: boolean
    txhash?: string
    target: string
    writer: string
    name: string
    discriminator: string
    mode: "create-only" | "compare-and-set"
    valueDigest: string
    expectedPriorDigest?: string | null
    /** The value itself, carried in the signed transaction. */
    value: unknown
}

interface AtomicWriteMeta {
    valueDigest: string
    discriminator: string
    /** What this write replaced, for a block rollback; null if it created. */
    previous: Record<string, unknown> | null
}

type Outcome = { success: boolean; message: string }

function atomicMeta(program: GCRStorageProgram | null | undefined): AtomicWriteMeta | null {
    const meta = program?.metadata as { atomicWork?: AtomicWriteMeta } | null | undefined
    return meta?.atomicWork ?? null
}

function currentDigest(program: GCRStorageProgram | null | undefined): string | undefined {
    if (!program || program.isDeleted) return undefined
    return atomicMeta(program)?.valueDigest ?? storageValueDigest(program.data)
}

/**
 * A Work's write to its derived storage address.
 *
 * Written into the ordinary storage-program table, so the result is readable
 * through the usual storage API. The address, the value's digest and the
 * replace rule are all checked here against the signed edit; the writer is
 * bound to the sender before this runs.
 */
export function applyAtomicStoragePut(
    edit: StoragePutEdit,
    programs: Map<string, GCRStorageProgram | null>,
    isRollback: boolean,
): Outcome {
    const current = programs.get(edit.target) ?? null

    if (isRollback) {
        if (!current || current.lastModifiedByTx !== edit.txhash || !atomicMeta(current)) {
            return { success: false, message: `cannot undo ${edit.target}: it was not written by this tx` }
        }
        const previous = atomicMeta(current)!.previous
        programs.set(
            edit.target,
            previous ? Object.assign(new GCRStorageProgram(), previous) : null,
        )
        return { success: true, message: "storage write undone" }
    }

    if (edit.target !== deriveStorageAddress(ATOMIC_STORAGE_DOMAIN, edit.writer, edit.name, edit.discriminator)) {
        return { success: false, message: `${edit.target} is not the address this writer derives` }
    }

    let canonical: string
    try {
        canonical = jcsCanonicalize(edit.value ?? null)
    } catch (error) {
        return { success: false, message: `value is not canonical JSON: ${error}` }
    }
    if (Buffer.byteLength(canonical, "utf8") > MAX_VALUE_BYTES) {
        return { success: false, message: `value exceeds ${MAX_VALUE_BYTES} bytes` }
    }
    if (storageValueDigest(edit.value) !== edit.valueDigest) {
        return { success: false, message: "value does not match its declared digest" }
    }

    const priorDigest = currentDigest(current)
    try {
        assertStorageWriteAllowed(priorDigest === undefined ? undefined : { valueDigest: priorDigest }, {
            address: edit.target,
            valueDigest: edit.valueDigest,
            mode: edit.mode,
            expectedPriorDigest: edit.expectedPriorDigest,
        })
    } catch (error) {
        if (error instanceof StorageWriteError) return { success: false, message: error.message }
        throw error
    }

    const txhash = edit.txhash ?? ""
    const previous = current
        ? (() => {
              // One level: a block writes an address at most once, and a
              // rollback only undoes that block.
              const snapshot = { ...current } as Record<string, unknown>
              const meta = atomicMeta(current)
              if (meta) snapshot.metadata = { atomicWork: { ...meta, previous: null } }
              return snapshot
          })()
        : null

    const next = Object.assign(new GCRStorageProgram(), current ?? {}) as GCRStorageProgram
    if (!current) {
        next.storageAddress = edit.target
        next.owner = edit.writer
        next.programName = edit.name
        next.encoding = "json"
        // Work outputs are evidence: anyone checking a receipt has to be
        // able to read what it commits to.
        next.acl = { mode: "public" }
        next.storageLocation = "onchain"
        next.ipfsCid = null
        next.salt = edit.discriminator
        next.createdByTx = txhash
        next.totalFeesPaid = 0n
        next.interactionTxs = []
    }
    next.data = edit.value as GCRStorageProgram["data"]
    next.sizeBytes = Buffer.byteLength(canonical, "utf8")
    next.metadata = {
        atomicWork: { valueDigest: edit.valueDigest, discriminator: edit.discriminator, previous },
    }
    next.lastModifiedByTx = txhash
    next.interactionTxs = [...(next.interactionTxs ?? []), txhash]
    next.isDeleted = false
    next.deletedByTx = null

    programs.set(edit.target, next)
    return { success: true, message: current ? "storage value replaced" : "storage value created" }
}
