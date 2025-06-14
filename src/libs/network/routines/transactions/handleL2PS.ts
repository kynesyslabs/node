import type { BlockContent, L2PSTransaction, Transaction } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import Hashing from "src/libs/crypto/hashing"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "../../server_rpc"
import _ from "lodash"
import { L2PS, L2PSEncryptedPayload } from "@kynesyslabs/demosdk/l2ps"
import { Cryptography } from "@kynesyslabs/demosdk/encryption"
/* NOTE
- Each l2ps is a list of nodes that are part of the l2ps
- Each l2ps partecipant has the private key of the l2ps (or equivalent)
- Each l2ps partecipant can register a transaction in the l2ps
- Each l2ps partecipant can retrieve a transaction from the l2ps
- // ! TODO For each l2ps message, it can be specified another key shared between the session partecipants only
- // ! TODO Only nodes that partecipate to the l2ps will maintain a copy of the l2ps transactions
- // ! TODO The non partecipating nodes will have a encrypted transactions hash property

*/


export default async function handleL2PS(
    l2psTx: L2PSTransaction,
): Promise<RPCResponse> {
    // ! TODO Finalize the below TODOs
    const response = _.cloneDeep(emptyResponse)
    // TODO Defining a subnet from the uid: checking if we have the config
    var key = null
    var iv = null
    // REVIEW Once we have the config, we should create a new L2PS instance and use it to decrypt the data
    const l2ps = await L2PS.create(key, iv)
    const decryptedTx = await l2ps.decryptTx(l2psTx)
    // NOTE Hash is already verified in the decryptTx function (sdk)
    // REVIEW Verify the signature of the decrypted transaction
    const from = decryptedTx.content.from
    const signature = decryptedTx.ed25519_signature
    const derivedHash = Hashing.sha256(JSON.stringify(decryptedTx.content)) // REVIEW This should be ok, check anyway
    // REVIEW We have to re-verify this one as confirmTransaction just confirm the encrypted tx
    const verified = Cryptography.verify(derivedHash, signature, from)
    if (!verified) {
        response.result = 400
        response.response = false
        response.extra = "Signature verification failed"
        return response
    }
    // TODO Add the encrypted transaction (NOT the decrypted one) to the local L2PS mempool
    // TODO Is the execution to be delegated to the l2ps nodes? As it cannot be done by the consensus as it will be in the future for the other txs
    response.result = 200
    response.response = decryptedTx
    return response
}
