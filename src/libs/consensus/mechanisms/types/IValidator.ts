// INFO This module implements Proof of Representation (PoR)

import forge from "node-forge"

import Mempool from "../../../blockchain/mempool"

export interface IValidator {
    connectionURL: string
    publicKey_string: string
    publicKey?: forge.pki.ed25519.BinaryBuffer
}

