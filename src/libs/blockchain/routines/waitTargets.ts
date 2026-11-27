/**
 * The last-block signers consensus should wait for: those still in the
 * staked set at the current head, excluding this node. A signer that
 * unstaked in the last block no longer publishes its height, so waiting on
 * it would only run out the clock.
 */
export function stillStakedSigners(
    signers: readonly string[],
    staked: ReadonlySet<string>,
    selfId: string | undefined,
): { wait: string[]; dropped: string[] } {
    const self = selfId?.toLowerCase()
    const wait: string[] = []
    const dropped: string[] = []
    for (const id of signers) {
        if (id.toLowerCase() === self) continue
        if (staked.has(id.toLowerCase())) wait.push(id)
        else dropped.push(id)
    }
    return { wait, dropped }
}
