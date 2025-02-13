import { GCR_Main } from "@/model/entities/GCRv2/GCR_Main"
import { Hashing } from "@kynesyslabs/demosdk/encryption"
import Datasource from "src/model/datasource"
import { GlobalChangeRegistry } from "src/model/entities/GCR/GlobalChangeRegistry"

// import Block from "../../block"
// import Chain from "../../chain"
// import GCR from "../../gcr/gcr"
// import Genesis from "../../types/genesisTypes"
// import { OperationResult } from "../executeOperations"

// TODO Implement other properties of the GCR object to be fetched and set from the database

// SECTION Balance management

// INFO Get the balance of a user
async function balance(PublicKey: string): Promise<bigint> {
    const db = await Datasource.getInstance()
    const GCRRepository = db.getDataSource().getRepository(GCR_Main)
    const status = await GCRRepository.findOneBy({ pubkey: PublicKey })
    return status.balance
}

// INFO Arbitrary function to set the balance of a user
async function setBalance(
    publicKey: string,
    balance: bigint,
): Promise<[boolean, string]> {
    const rawData: GCR_Main = {
        assignedTxs: [],
        identities: {
            xm: new Map(),
            web2: new Map(),
        },
        balance: BigInt(balance),
        nonce: 0,
        pubkey: publicKey,
    }

    const db = await Datasource.getInstance()
    const GCRRepository = db.getDataSource().getRepository(GCR_Main)
    let GCRSearch = await GCRRepository.findOneBy({ pubkey: publicKey })

    if (!GCRSearch) {
        GCRSearch = rawData
    }

    // Keeping the things we need and just updating the balance
    let GCRUpdate = GCRSearch
    GCRUpdate.balance = BigInt(balance)

    // Saving the GCR
    await GCRRepository.save(GCRUpdate)
    return [true, ""]
}

// INFO Add a balance to a user
async function addBalance(
    address: string,
    amount: bigint,
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
    amount: bigint,
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
    amount: bigint,
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
