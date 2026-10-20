import { Peer } from "src/libs/peer"

/**
 * Keep only signatures whose identity belongs to the current committee.
 * The original key spelling is preserved for signature verification/storage;
 * membership comparison is case-insensitive because public-key hex is
 * represented inconsistently by some transports.
 */
export function filterSignaturesByShardMembership(
    signatures: Record<string, string>,
    shard: Pick<Peer, "identity">[],
): Record<string, string> {
    const memberIdentities = new Set(
        shard.map(member => member.identity.toLowerCase()),
    )
    return Object.fromEntries(
        Object.entries(signatures).filter(([identity]) =>
            memberIdentities.has(identity.toLowerCase()),
        ),
    )
}
