/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { NodeCall } from "src/libs/network/manageNodeCall"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import Peer from "../Peer"

type BufferPayload = {
    type: "Buffer"
    data: number[]
}

type IdentityEnvelope = {
    publicKey?: string
    data?: number[] | string
}

function asHexString(value: string): string | null {
    const trimmed = value.trim()
    const parts = trimmed.includes(":") ? trimmed.split(":", 2) : [null, trimmed]
    const rawWithoutPrefix = parts[1]

    if (!rawWithoutPrefix) {
        return null
    }

    const hasPrefix = rawWithoutPrefix.startsWith("0x") || rawWithoutPrefix.startsWith("0X")
    const candidate = hasPrefix ? rawWithoutPrefix.slice(2) : rawWithoutPrefix

    if (!/^[0-9a-fA-F]+$/.test(candidate)) {
        return null
    }

    return `0x${candidate.toLowerCase()}`
}

function normalizeIdentity(raw: unknown): string | null {
    if (!raw) {
        return null
    }

    if (typeof raw === "string") {
        return asHexString(raw)
    }

    if (raw instanceof Uint8Array) {
        return uint8ArrayToHex(raw).toLowerCase()
    }

    if (ArrayBuffer.isView(raw)) {
        const view = raw as ArrayBufferView
        const bytes =
            view instanceof Uint8Array
                ? view
                : new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
        return uint8ArrayToHex(bytes).toLowerCase()
    }

    if (raw instanceof ArrayBuffer) {
        return uint8ArrayToHex(new Uint8Array(raw)).toLowerCase()
    }

    if (Array.isArray(raw) && raw.every(item => typeof item === "number")) {
        return uint8ArrayToHex(Uint8Array.from(raw)).toLowerCase()
    }

    const maybeBuffer = raw as Partial<BufferPayload>
    if (maybeBuffer?.type === "Buffer" && Array.isArray(maybeBuffer.data)) {
        return uint8ArrayToHex(
            Uint8Array.from(maybeBuffer.data),
        ).toLowerCase()
    }

    const maybeEnvelope = raw as IdentityEnvelope
    if (typeof maybeEnvelope?.publicKey === "string") {
        return asHexString(maybeEnvelope.publicKey)
    }

    if (
        typeof maybeEnvelope?.data === "string" ||
        Array.isArray(maybeEnvelope?.data)
    ) {
        return normalizeIdentity(maybeEnvelope.data)
    }

    return null
}

function normalizeExpectedIdentity(expectedKey: string): string | null {
    if (!expectedKey) {
        return null
    }

    const normalized = asHexString(expectedKey)
    if (normalized) {
        return normalized
    }

    // In some cases keys might arrive already normalized but without the 0x prefix
    if (/^[0-9a-fA-F]+$/.test(expectedKey)) {
        return `0x${expectedKey.toLowerCase()}`
    }

    return null
}

// proxy method
export async function verifyPeer(
    peer: Peer,
    expectedKey: string,
): Promise<Peer> {
    await getPeerIdentity(peer, expectedKey)
    return peer
}

// Peer is verified and its status is updated
export default async function getPeerIdentity(
    peer: Peer,
    expectedKey: string,
): Promise<Peer> {
    // Getting our identity
    console.warn("[PEER AUTHENTICATION] Getting peer identity")
    console.log(peer)
    console.log(expectedKey)

    const nodeCall: NodeCall = {
        message: "getPeerIdentity",
        data: null,
        muid: null,
    }

    const response = await peer.call({
        method: "nodeCall",
        params: [nodeCall],
    })
    console.log(
        "[PEER AUTHENTICATION] Response Received: " +
            JSON.stringify(response, null, 2),
    )
    // Response management
    if (response.result === 200) {
        console.log("[PEER AUTHENTICATION] Received response")
        console.log(response.response)

        const receivedIdentity = normalizeIdentity(response.response)
        const expectedIdentity = normalizeExpectedIdentity(expectedKey)

        if (!receivedIdentity) {
            console.log(
                "[PEER AUTHENTICATION] Unable to normalize identity payload",
            )
            return null
        }

        if (!expectedIdentity) {
            console.log(
                "[PEER AUTHENTICATION] Unable to normalize expected identity",
            )
            return null
        }

        if (receivedIdentity === expectedIdentity) {
            console.log("[PEER AUTHENTICATION] Identity is the expected one")
        } else {
            console.log(
                "[PEER AUTHENTICATION] Identity is not the expected one",
            )
            console.log("Expected: ")
            console.log(expectedIdentity)
            console.log("Received: ")
            console.log(receivedIdentity)
            return null
        }
        // Adding the property to the peer
        peer.identity = receivedIdentity // Identity is now known
        peer.status.online = true // Peer is now online
        peer.status.ready = true // Peer is now ready
        peer.status.timestamp = new Date().getTime()
        peer.verification.status = true // We verified the peer
        peer.verification.message = "getPeerIdentity routine verified"
        peer.verification.timestamp = new Date().getTime()
    } else {
        console.log(
            "[PEER AUTHENTICATION] [FAILED] Response " +
                response.result +
                " received: " +
                response.response,
        )
        return null
    }
    // ? Should we add it to the peerList here instead of in the peerBootstrap routine / hello_peer routine?
    return peer
}
