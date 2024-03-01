import { Operation, OperationResult } from "../executeOperations"
import GLS from "../../gls/gls"
import Genesis from "../../types/genesisTypes"
import Chain from "../../chain"
import Block from "../../block"
import Datasource from "src/model/datasource"
import { StatusNative } from "src/model/entities/StatusNative"

// TODO Implement other properties of the GLS object to be fetched and set from the database

// SECTION Balance management

// INFO Transfer a balance from one user to another
async function transferBalance() {}

// INFO Add a balance to a user
async function addBalance() {}

// INFO Remove a balance from a user
async function removeBalance() {}

// INFO Arbitrary function to set the balance of a user
async function setBalance(address: string, balance: number) {
    const rawData = {
        address: address,
        balance: balance,
        nonce: 0,
        tx_list: "[]",
    }

    const db = await Datasource.getInstance()
    const StatusNativeRepository = db
        .getDataSource()
        .getRepository(StatusNative)
    return await StatusNativeRepository.save(rawData)
}

// INFO Get the balance of a user
async function balance() {}

// !SECTION balance management

let manageNative = {
    balance: {
        transferBalance: transferBalance,
        addBalance: addBalance,
        removeBalance: removeBalance,
        setBalance: setBalance,
        balance: balance,
    },
}

export default manageNative
