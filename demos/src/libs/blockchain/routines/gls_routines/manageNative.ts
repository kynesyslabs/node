import { Operation, OperationResult } from "../executeOperations"
import GLS from "../../gls/gls"
import Genesis from "../../types/genesisTypes"
import Chain from "../../chain"
import Block from "../../block"

async function transfer() {

}
async function add() {

}

async function remove() {

}

async function balance() {

}

let native = {
	transfer: transfer,
    add: add,
    remove: remove,
    balance: balance,
}

export default native