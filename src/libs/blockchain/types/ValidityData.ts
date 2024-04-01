import { Operation } from "src/libs/blockchain/gls/types/Operations"
import Transaction from "../transaction"
import { pki } from "node-forge"

export interface ValidityData {
    data: {
        valid: boolean
        reference_block: number
        message: string
        gas_operation: Operation
        transaction: Transaction
    }
    signature: pki.ed25519.BinaryBuffer
    rpc_public_key: pki.ed25519.BinaryBuffer
}