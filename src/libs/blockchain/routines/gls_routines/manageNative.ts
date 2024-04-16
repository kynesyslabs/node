import Datasource from "src/model/datasource"
import { StatusNative } from "src/model/entities/StatusNative"

// import Block from "../../block"
// import Chain from "../../chain"
// import GLS from "../../gls/gls"
// import Genesis from "../../types/genesisTypes"
// import { OperationResult } from "../executeOperations"

// TODO Implement other properties of the GLS object to be fetched and set from the database

// SECTION Balance management

// INFO Get the balance of a user
async function balance(address: string): Promise<number> {
    const db = await Datasource.getInstance()
    const StatusNativeRepository = db
        .getDataSource()
        .getRepository(StatusNative)
    const status = await StatusNativeRepository.findOneBy({ address })
    return status.balance
}

// INFO Arbitrary function to set the balance of a user
async function setBalance(
    address: string,
    balance: number,
): Promise<[boolean, string]> {
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
    await StatusNativeRepository.save(rawData)
    return [true, ""]
}

// INFO Add a balance to a user
async function addBalance(
    address: string,
    amount: number,
): Promise<[boolean, string]> {
    // Get the current balance
    const currentBalance = await balance(address)
    // Add the amount
    const newBalance = currentBalance + amount
    // Set the new balance
    await setBalance(address, newBalance)
    return [true, ""]
}

// INFO Remove a balance from a user
async function removeBalance(
    address: string,
    amount: number,
): Promise<[boolean, string]> {
    // Get the current balance
    const currentBalance = await balance(address)
    // NOTE Check if the user has enough balance
    if (currentBalance < amount) {
        return [false, "Insufficient balance"]
    }
    // Remove the amount
    const newBalance = currentBalance - amount
    // Set the new balance
    await setBalance(address, newBalance)
    return [true, ""]
}

// INFO Transfer a balance from one user to another
async function transferBalance(
    address_from: string,
    address_to: string,
    amount: number,
): Promise<[boolean, string]> {
    // Remove the amount from the sender
    let success = await removeBalance(address_from, amount)
    if (!success[0]) {
        return [false, success[1]]
    }
    // Add the amount to the receiver
    await addBalance(address_to, amount)
    return [true, ""]
}

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
