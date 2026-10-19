import fs from "fs"

/**
 * A node that created its block 0 from an edited genesis file refuses to
 * bootstrap, but the block it stored stays in the database. The next boot finds
 * a block 0 that predates it and would take it for the network's, so the refusal
 * is recorded in a marker file next to the genesis and repeated until the cause
 * is gone.
 */

export interface RefusalMarker {
    message: string
    /** Hash of the block 0 the refused node had stored. */
    storedHash: string
    /** What the peer advertised when the node was refused. */
    peerHash: string
    at: string
}

export function writeRefusalMarker(
    path: string,
    marker: Omit<RefusalMarker, "at">,
): void {
    const full: RefusalMarker = { ...marker, at: new Date().toISOString() }
    fs.writeFileSync(path, JSON.stringify(full, null, 2))
}

export function clearRefusalMarker(path: string): boolean {
    if (!fs.existsSync(path)) return false
    fs.rmSync(path, { force: true })
    return true
}

/**
 * The error to raise at boot, or null when there is nothing to raise. The marker
 * is stale, and removed, once the stored block 0 is a different one from the
 * block the refusal was about (the database was wiped and rebuilt from a restored
 * file). A marker that cannot be read is treated as still in force.
 */
export function pendingRefusal(
    path: string,
    currentStoredHash: string | null,
): string | null {
    if (!fs.existsSync(path)) return null
    let marker: RefusalMarker
    try {
        marker = JSON.parse(fs.readFileSync(path, "utf8"))
    } catch {
        return (
            `A previous boot refused to bootstrap and left ${path}, which cannot be read. ` +
            "Restore the genesis file as it was when the chain was created, wipe the database, " +
            `delete ${path}, and restart.`
        )
    }
    if (currentStoredHash !== marker.storedHash) {
        clearRefusalMarker(path)
        return null
    }
    return (
        `Bootstrap was refused on ${marker.at} and the cause is still there ` +
        `(stored block 0 ${marker.storedHash}, peer advertised ${marker.peerHash}): ${marker.message} ` +
        `Once the genesis file is restored and the database wiped, delete ${path} (or let the ` +
        "next clean boot remove it) and restart."
    )
}
