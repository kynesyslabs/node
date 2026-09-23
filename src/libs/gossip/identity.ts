import fs from "node:fs"
import type { PrivateKey } from "@libp2p/interface"
import {
    generateKeyPair,
    privateKeyFromProtobuf,
    privateKeyToProtobuf,
} from "@libp2p/crypto/keys"

import log from "src/utilities/logger"

/**
 * Transport-only keypair: derives the libp2p peerId, never signs
 * application payloads. Disposable — a fresh key just yields a new peerId
 * that propagates via the next heights record.
 */
export async function loadOrCreateTransportKey(
    keyFile: string,
): Promise<PrivateKey> {
    try {
        if (fs.existsSync(keyFile)) {
            const raw = fs.readFileSync(keyFile)
            return privateKeyFromProtobuf(new Uint8Array(raw))
        }
    } catch (e) {
        log.warning(
            `[GOSSIP] transport key at ${keyFile} unreadable (${
                e instanceof Error ? e.message : String(e)
            }); generating a new one`,
        )
    }

    const key = await generateKeyPair("Ed25519")
    fs.writeFileSync(keyFile, privateKeyToProtobuf(key), { mode: 0o600 })
    return key
}
