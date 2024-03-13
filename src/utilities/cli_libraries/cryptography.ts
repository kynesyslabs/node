import forge from "node-forge"

import Wallet from "./wallet"

// INFO Using wallet identity properties this class enables crypto operations
export default class Cryptography {
    private static instance: Cryptography
    identity: any = { publicKey: null, privateKey: null }

    public static getInstance(): Cryptography {
        if (!Cryptography.instance) {
            Cryptography.instance = new Cryptography()
        }
        return Cryptography.instance
    }

    constructor() {}

    dispatch(divided_input) {
        // TODO as in wallet
    }

    public sign(message: any) {
        this.identity = Wallet.getInstance().identity
        let signature = forge.pki.ed25519.sign({
            message: message,
            privateKey: this.identity.privateKey,
        })
        return signature
    }

    public verify(
        message: any,
        signature: forge.pki.ed25519.BinaryBuffer,
        publicKey: forge.pki.ed25519.BinaryBuffer,
    ) {
        let verified = forge.pki.ed25519.verify({
            message: message,
            signature: signature,
            publicKey: publicKey,
        })
        return verified
    }
}
