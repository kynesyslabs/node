/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/* TODO

- Signature su entrambe le chain se richiedono sender
- Signature per conto di se possibile
- No signature per pubblici e from

*/

import Hashing from "src/libs/crypto/hashing"
import Cryptography from "src/libs/crypto/cryptography"
import forge from "node-forge"

export interface IParams {
    key: string;
    value: string;
}

// INFO Interface for a raw chain operation
export interface IRawChainOperation {
    type: "read" | "write"
    chain: string // REVIEW Force check on the chain availability?
    operation: string // TODO This will be called by the multichain object based on its keys
    parameters: IParams[]
}

// INFO Interface for a single chain operation signed and hashed
export interface IChainOperation {
    content: IRawChainOperation
    hash: string
    signature: forge.pki.ed25519.BinaryBuffer
}

// INFO Interface for the multichain request content, aka the group of chain operations
export interface IMultichainOperations {
    type: "read"|"write"
    operations: IChainOperation[]
}

// INFO Interface for the multichain object (serializable)
export interface IMultichainRequest {
    content: IMultichainOperations[]
    hash: string // Hashing this.content
    signature: forge.pki.ed25519.BinaryBuffer // Signing content's hash
}

// INFO Multichain object with methods and singleton / multiton support (non serializable)
export class MultichainRequest {
    data: IMultichainRequest

    private static instance: MultichainRequest
    private static instances: Map<string, MultichainRequest>

    constructor() {
        this.data = {
            content: [],
            hash: "",
            signature: "",
        }
    }

    // INFO Treating the class as a singleton
    public static getInstance(): MultichainRequest {
        if (!MultichainRequest.instance) {
            MultichainRequest.instance = new MultichainRequest()
        }
        return MultichainRequest.instance
    }

    // INFO Supporting a multi-singleton logic with names
    public static getNamedInstance(name: string): MultichainRequest {
        // Supporting multiple instances if not yet declared
        if (!MultichainRequest.instances) {
            MultichainRequest.instances = new Map<string, MultichainRequest>()
        }
        // Looking for an existing instance with the given name or creating a new one if not found
        if (!MultichainRequest.instances.has(name)) {
            MultichainRequest.instances.set(name, new MultichainRequest())
        }
        return MultichainRequest.instances.get(name)
    }

    // ANCHOR Methods

    // INFO Hashing and signing the multichain request content
    public sign(privateKey: forge.pki.ed25519.BinaryBuffer) {
        const hash = Hashing.sha256(JSON.stringify(this.data.content))
        const signature = Cryptography.sign(hash, privateKey)
        this.data.signature = signature
    }
}

// INFO Entry point for the multichain endpoint
export default async function multichainDispatcher(request: IMultichainRequest) {
    let response = "not yet implemented"
    // TODO
    return response
}