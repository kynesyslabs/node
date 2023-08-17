import { calls } from "./calls.js"
import * as forge from "node-forge"

// INFO Supporting txs
let transactions = {
    prepare: async function (data) {
        let thisTx = calls.skeletons.transaction
        // TODO: Implement
        thisTx.content = data
        return thisTx
    },
    sign: async function (raw_tx, private_key) {
        // TODO: Implement
        raw_tx.signature = forge.pki.ed25519.sign(raw_tx.content, private_key) // REVIEW if it is working right
        return raw_tx
    },
    broadcast: async function (signed_tx) {
        // TODO: Implement
        return await calls.nodeCall("tx", {
            tx: signed_tx,
        }) // And review
    },
}

exports.transactions = transactions