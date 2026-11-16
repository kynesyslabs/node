import { mock } from "bun:test"

type Verify = (input: {
    algorithm: string
    message: Uint8Array
    signature: Uint8Array
    publicKey: Uint8Array
}) => Promise<boolean>
type Sign = (
    algorithm: string,
    message: Uint8Array,
) => Promise<{ signature: Uint8Array }>

/**
 * Module mocks a hello exchange needs besides mockCore: signatures, sync
 * claims and gossip. Call at top level, ahead of importing PeerManager.
 */
export function mockHelloDeps({
    verify = async () => true,
    sign = async () => ({ signature: new Uint8Array(64) }),
}: { verify?: Verify; sign?: Sign } = {}): void {
    mock.module("src/libs/blockchain/validation/txValidatorPool", () => ({
        __esModule: true,
        default: { getInstance: () => ({ verify, sign }) },
    }))
    mock.module("src/libs/peer/syncClaims", () => ({
        unknownSync: () => ({ status: false, block: null, block_hash: null }),
        corroborateSyncData: async () => ({
            status: false,
            block: null,
            block_hash: null,
        }),
    }))
    mock.module("src/libs/gossip/GossipManager", () => ({
        __esModule: true,
        default: { isEnabled: () => false },
    }))
}
