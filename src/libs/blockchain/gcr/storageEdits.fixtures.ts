/**
 * A sender, its stored program and the edits of a storage transaction, for
 * tests that apply them through HandleGCR without a database. Call
 * `installStorageEditMocks` before importing HandleGCR.
 */

import { mock } from "bun:test"

import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"

export const SENDER = "0x" + "ab".repeat(32)
export const ADDRESS = "stor-" + "ef".repeat(20)
export const START = 100n

export function installStorageEditMocks(): void {
    const fakeDataSource = { getRepository: () => ({}) }
    const datasourceModule = () => ({
        __esModule: true,
        dataSource: fakeDataSource,
        default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
    })
    mock.module("src/model/datasource", datasourceModule)
    mock.module("@/model/datasource", datasourceModule)
    mock.module("src/utilities/logger", () => ({
        __esModule: true,
        default: { debug: () => {}, info: () => {}, warning: () => {}, error: () => {}, only: () => {} },
    }))
}

/** The program SENDER owns at ADDRESS, holding `{ n: 1 }`. */
export function storedProgram(): GCRStorageProgram {
    return Object.assign(new GCRStorageProgram(), {
        storageAddress: ADDRESS,
        owner: SENDER,
        programName: "probe",
        encoding: "json",
        data: { n: 1 },
        sizeBytes: 7,
        acl: { mode: "owner" },
        metadata: null,
        storageLocation: "onchain",
        ipfsCid: null,
        salt: null,
        createdByTx: "tx_create",
        lastModifiedByTx: "tx_create",
        interactionTxs: ["tx_create"],
        totalFeesPaid: 1n,
        isDeleted: false,
        deletedByTx: null,
    })
}

/** SENDER's account with START, and `program` at ADDRESS when given. */
export async function storageCaches(program: unknown): Promise<any> {
    const { default: HandleGCR } = await import("./handleGCR")
    return {
        accounts: new Map([[SENDER, await HandleGCR.createAccount(SENDER, { balance: START }, true)]]),
        storagePrograms: new Map(program ? [[ADDRESS, program]] : []),
        tlsNotaries: new Map(),
        atomicWorks: new Map(),
        resourceSlots: new Map(),
    }
}

export const burn = (amount: number, account = SENDER) => ({
    type: "balance",
    operation: "remove",
    account,
    amount,
    isRollback: false,
    txhash: "",
})

export const storage = (operation: string, variables: Record<string, unknown>) => ({
    type: "storageProgram",
    target: ADDRESS,
    isRollback: false,
    txhash: "",
    context: {
        operation,
        sender: SENDER,
        data: { variables: { operation, storageAddress: ADDRESS, ...variables }, metadata: null },
    },
})

export const tx = (edits: unknown[]): any => ({
    hash: "aa".repeat(32),
    content: { type: "storageProgram", from: SENDER, from_ed25519_address: SENDER, gcr_edits: edits },
})
