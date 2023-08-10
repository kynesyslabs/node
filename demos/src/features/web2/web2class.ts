import { time } from "console"
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { rsa } from "src/libs/crypto"
import { pki } from "node-forge"
import Hashing from "src/libs/crypto/hashing"
import Cryptography from "src/libs/crypto/cryptography"
import { Peer } from "src/libs/peer"

export interface IRequest {
    timestamp: number
    status: string
    url: string
    verb: string
}

export interface IResponse {
    timestamp: number
    result: string
    hash: string
}
export interface IData {
    request?: IRequest
    response?: IResponse
    operator?: Peer
}

export interface IWitness {
    response: { peer: Peer; timestamp: number; hash: string }
    signature: pki.ed25519.BinaryBuffer
}

export interface IWitnesses {
    [publicKey: string]: IWitness
}

export class Web2Data {
    status: string
    data: IData
    witnesses: IWitnesses
    data_signature: null | pki.ed25519.BinaryBuffer
    witnesses_signature: null | string
    peer_count: number | null

    constructor() {
        this.status = "new"
        this.data = {
            request: { timestamp: null, status: null, url: null, verb: null },
            response: { timestamp: null, result: null, hash: null },
            operator: null,
        }
        this.witnesses = {}
        this.data_signature = null
        this.witnesses_signature = null
        this.peer_count = null
    }

    async signData(privateKey: pki.ed25519.BinaryBuffer): Promise<void> {
        this.data_signature = Cryptography.sign(JSON.stringify(this.data), privateKey)
        /*await rsa.sign(
            JSON.stringify(this.data),
            privateKey,
        )*/
    }

    async addWitness(
        publicKey: any, //TODO - improve types for keys
        privateKey: any, //TODO - improve types for keys
        peer: Peer,
        data: IResponse,
        timestamp: number,
    ): Promise<void> {
        let witness: IWitness = {
            response: {
                peer: peer,
                timestamp: timestamp,
                hash: Hashing.sha256(JSON.stringify(data)),
            },
            signature: Cryptography.sign(JSON.stringify(data), privateKey),
        }
        this.witnesses[publicKey as unknown as string] = witness //TODO - Horrible typing. Fix this
    }

    async signWitnesses(privateKey: pki.rsa.PrivateKey): Promise<void> {
        this.witnesses_signature = await rsa.sign(
            JSON.stringify(this.witnesses),
            privateKey,
        )
    }
}
