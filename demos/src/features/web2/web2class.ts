import { rsa } from "src/libs/crypto"
import { pki } from "node-forge"

import { Peer } from "src/libs/peer"

export interface IData {
    request: { timestamp: null | number; status: null | string }
    response: {
        timestamp: null | number
        result: null | string
        hash: null | string
    }
    operator: Peer
}

export interface IWitness {
    response: { peer: Peer; timestamp: null | number; hash: null | string }
    signature: null | string
}

export interface IWitnesses {
    [publicKey: string]: IWitness
}

export class Web2Data {
    status: string
    data: IData
    witnesses: IWitnesses
    data_signature: null | string
    witnesses_signature: null | string

    constructor() {
        this.status = "new"
        this.data = {
            request: { timestamp: null, status: null },
            response: { timestamp: null, result: null, hash: null },
            operator: new Peer(),
        }
        this.witnesses = {}
        this.data_signature = null
        this.witnesses_signature = null
    }

    async signData(privateKey: pki.rsa.PrivateKey): Promise<void> {
        this.data_signature = await rsa.sign(
            JSON.stringify(this.data),
            privateKey,
        )
    }

    async signWitnesses(privateKey: pki.rsa.PrivateKey): Promise<void> {
        this.witnesses_signature = await rsa.sign(
            JSON.stringify(this.witnesses),
            privateKey,
        )
    }
}
