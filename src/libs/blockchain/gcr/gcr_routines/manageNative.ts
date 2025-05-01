import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
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
async function balance(publicKey: string): Promise<bigint> {
    const db = await Datasource.getInstance()
    const gcrRepository = db.getDataSource().getRepository(GCRMain)
    const status = await gcrRepository.findOneBy({ pubkey: publicKey })
    return status.balance
}

// INFO Arbitrary function to set the balance of a user
async function setBalance(
    publicKey: string,
    balance: bigint,
): Promise<[boolean, string]> {
    const rawData: GCRMain = {
        assignedTxs: [],
        identities: {
            xm: {},
            web2: {},
        },
        balance: BigInt(balance),
        nonce: 0,
        pubkey: publicKey,
        points: {
            totalPoints: 0,
            breakdown: {
                web3Wallets: 0,
                socialAccounts: 0,
            },
            lastUpdated: new Date(),
        },
    }

    const db = await Datasource.getInstance()
    const gcrRepository = db.getDataSource().getRepository(GCRMain)
    let gcrSearch = await gcrRepository.findOneBy({ pubkey: publicKey })

    if (!gcrSearch) {
        gcrSearch = rawData
    }

    // Keeping the things we need and just updating the balance
    const gcrUpdate = gcrSearch
    gcrUpdate.balance = BigInt(balance)

    // Saving the GCR
    await gcrRepository.save(gcrUpdate)
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
    addressFrom: string,
    addressTo: string,
    amount: bigint,
): Promise<[boolean, string]> {
    // Remove the amount from the sender
    const success = await removeBalance(addressFrom, amount)
    if (!success[0]) {
        return [false, success[1]]
    }
    // Add the amount to the receiver
    await addBalance(addressTo, amount)
    return [true, ""]
}

// !SECTION balance management

const manageNative = {
    balance: {
        transferBalance: transferBalance,
        addBalance: addBalance,
        removeBalance: removeBalance,
        setBalance: setBalance,
        balance: balance,
    },
}

export default manageNative
