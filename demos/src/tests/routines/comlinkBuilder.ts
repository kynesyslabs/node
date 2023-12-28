import ComLink from "src/libs/communications/comlink"
import Hashing from "src/libs/crypto/hashing"
import Cryptography from "src/libs/crypto/cryptography"
import forge from "node-forge"

export default class ComLinkUtils {
    static comlink: ComLink = new ComLink()

    constructor() {}

    static createComLink(
        message: any,
        from: forge.pki.ed25519.BinaryBuffer,
        to: forge.pki.ed25519.BinaryBuffer, // REVIEW Or connection socket?
        previousHashes: string[] = [], // Optional, depends if is first message or not
        connectionString: string = "no_connection_string_provided", // Relatively optional
        requireReply: boolean = false,
        isReply: boolean = false,
    ): ComLink {
        let new_comlink = new ComLink()
        // NOTE Building step by step the comlink as required
        new_comlink.chain.current.currentMessage = message
        new_comlink.chain.current.currentMessageHash = Hashing.sha256(
            JSON.stringify(new_comlink.chain.current.currentMessage),
        )
        new_comlink.chain.current.previousHashes = previousHashes
        new_comlink.chain.comlinkCurrentHash = Hashing.sha256(
            JSON.stringify(new_comlink.chain.current),
        )
        // TODO Sign current hash
        new_comlink.properties.connection_string = connectionString
        new_comlink.properties.require_reply = requireReply
        new_comlink.properties.is_reply = isReply
        return new_comlink
    }
}
