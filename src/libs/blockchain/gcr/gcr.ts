// ! This should be deprecated in favor of the GCREdit system, if not used please remove it

/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/* INFO GCR
 * While the GCR is not part of the blockchain itself, that does not mean that
 * blockchain security does not apply to it. Even if a DEMOS Node does not store
 * the GCR as part of the blockchain (mainly due to its mutable nature), every
 * GCR property can and is traced back to the corresponding set of Operations.
 * From there, finding the corresponding Transaction for each Operation is trivial.
 * This ensures that even if it is a separate table, the GCR remains cryptographically secure.
 * The specifications to achieve this grade of security requires nodes to store GCR
 * data along with the corresponding on-chain data to be able to verify it at any time.
 *
 */

/* INFO Operations
 * An Operation is a modification of the GCR derived from a transaction
 * While in transactions like "transfer X tokens to Y" the Operation is
 * a simple transfer, one could think that Operation = Transaction but
 * it is very likely and very possible that from a Transaction multiple
 * Operations are derived. For example, sending X tokens to y also means
 * that the sender will pay gas so another Operation: "pay Z gas".
 *
 * Operations are useful because while Transactions store in the Blockchain
 * everything that happens, Operations quickly update the Blockchain GCR
 * with all the necessary references to the corresponding Transactions
 * without having to load and parse every single Transaction to verify the GCR.
 *
 * Basically, Operations have the role of a quick reference index to modify, derive
 * and trace back the GCR modifications efficiently.
 *
 */

// TODO genesis.json: see how it is stored on chain and make a method to
// TODO insert it in the gcr automatically so that the parameters of the
// TODO chain are both immutable and editable at the same time

import * as fs from "fs"
import Hashing from "src/libs/crypto/hashing"
import Datasource from "src/model/datasource"
import { GlobalChangeRegistry } from "src/model/entities/GCR/GlobalChangeRegistry"
import { GCRExtended } from "src/model/entities/GCR/GlobalChangeRegistry"
import { Validators } from "src/model/entities/Validators"
import terminalkit from "terminal-kit"
import { LessThanOrEqual, Repository } from "typeorm"

import {
    Operation,
    OperationRegistrySlot,
    OperationResult,
} from "@kynesyslabs/demosdk/types"

import Chain from "../chain"
import executeOperations, { Actor } from "../routines/executeOperations"
import gcrStateSave from "./gcr_routines/gcrStateSaverHelper"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"

const term = terminalkit.terminal

// ? This class should be deprecated: ensure that and remove it
export class OperationsRegistry {
    path = "data/operations.json"
    operations: OperationRegistrySlot[] = []

    constructor() {
        // Creating an empty registry if it doesn't exist
        if (!fs.existsSync(this.path)) fs.writeFileSync(this.path, "[]")
        this.operations = JSON.parse(fs.readFileSync(this.path).toString())
    }

    // INFO Adding an operation to the registry
    add(operation: Operation) {
        this.operations.push({
            operation: operation,
            status: "pending",
            result: {
                success: false,
                message: "ot yet processed",
            },
            timestamp: Date.now(),
        })
        fs.writeFileSync(this.path, JSON.stringify(this.operations))
    }

    // INFO Getting the full list of operations currently in the registry
    get(): OperationRegistrySlot[] {
        return this.operations
    }
}

// INFO Besides the static methods, the GCR store all the operations to be done in the current block so that they can be executed in order
export default class GCR {
    private static instance: GCR
    operations: Operation[] // TODO It will become the above implementation

    private constructor() {
        this.operations = []
    }

    // Singleton logic
    static getInstance(): GCR {
        if (!this.instance) {
            this.instance = new GCR()
        }
        return this.instance
    }

    // NOTE Due to the complexity of this method, it is imported by the appropriate module
    // INFO Any type of transaction is already converted as a native DEMOS transaction
    //      so that the appropriate Operatin can be executed
    async executeOperations(): Promise<Map<string, Actor>> {
        const result = await executeOperations(this.operations)
        return result
    }

    static async getGCRStatusNativeTable() {
        const db = await Datasource.getInstance()
        const gcrRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)
        return await gcrRepository.find()
    }

    static async getGCRStatusPropertiesTable(publicKey: string) {
        const db = await Datasource.getInstance()
        const gcrRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)
        const gcrSearch = await gcrRepository.findOneBy({ publicKey })
        const gcrExtendedData = gcrSearch?.extended
        return gcrExtendedData
    }

    static async getGCRNativeFor(address: string) {
        const db = await Datasource.getInstance()
        const gcrRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)
        return await gcrRepository.findOne({
            where: { publicKey: address },
        })
    }

    static async getGCRPropertiesFor(
        address: string,
        field: keyof GCRExtended,
    ) {
        const db = await Datasource.getInstance()
        const gcrRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)
        const gcrSearch = await gcrRepository.findOneBy({
            publicKey: address,
        })
        const gcrExtendedData = gcrSearch?.extended
        return gcrExtendedData[field]
    }

    // ANCHOR Balances retrieval

    static async getGCRNativeBalance(address: string) {
        const db = await Datasource.getInstance()
        const gcrRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)

        try {
            const response = await gcrRepository.findOne({
                select: ["details"],
                where: { publicKey: address },
            })
            return response ? response.details.content.balance : 0
        } catch (e) {
            term.yellow("[GET BALANCE] No balance for: " + address + "\n")
            return 0
        }
    }

    static async getGCRTokenBalance(address: string, tokenAddress: string) {
        const db = await Datasource.getInstance()
        const gcrRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)

        try {
            const gcrSearch = await gcrRepository.findOneBy({
                publicKey: address,
            })
            const gcrExtendedData = gcrSearch?.extended
            return gcrExtendedData && gcrExtendedData.tokens
                ? gcrExtendedData.tokens[tokenAddress]
                : 0
        } catch (e) {
            console.error(e)
        }
    }

    static async getGCRNFTBalance(address: string, nftAddress: string) {
        const db = await Datasource.getInstance()
        const gcrRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)

        try {
            const gcrSearch = await gcrRepository.findOneBy({
                publicKey: address,
            })
            const gcrExtendedData = gcrSearch?.extended
            return gcrExtendedData && gcrExtendedData.nfts
                ? gcrExtendedData.nfts[nftAddress]
                : 0
        } catch (e) {
            console.error(e)
        }
    }

    static async getGCRLastBlockBaseGas(): Promise<number> {
        // TODO Implement and make it dynamic
        /* let chainProperties = await GCR.getGCRChainProperties()
        return chainProperties.gas_multiplier */
        return 1
    }

    // INFO In the GCR properties table, the special row "DEMOS Network" defines, in the other
    // field, the properties of the chain itself shared by all its members.
    // TODO Maybe implement it at genesis or retrieve the genesis from chain?
    static async getGCRChainProperties(): Promise<any> {
        const db = await Datasource.getInstance()
        const gcrRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)

        try {
            const gcrSearch = await gcrRepository.findOneBy({
                publicKey: "DEMOS Network",
            })
            const gcrExtendedData = gcrSearch?.extended
            return gcrExtendedData && gcrExtendedData.other
        } catch (e) {
            // Handle the error appropriately
            console.error("Error fetching GCR chain properties:", e)
        }
    }

    // SECTION Validators management

    // INFO The following getter is used to retrieve the hashed form of the sum of all the stakes at block N
    static async getGCRHashedStakes(n: number = null) {
        if (!n) {
            n = await Chain.getLastBlockNumber() // Ensure this method is also ported to TypeORM if necessary
        }

        const db = await Datasource.getInstance()
        const validatorsRepository = db
            .getDataSource()
            .getRepository(Validators)

        try {
            const stakes = await validatorsRepository.find({
                where: { first_seen: LessThanOrEqual(n) },
                order: { first_seen: "DESC" },
            })

            // Hashing
            let total = 0
            stakes.forEach(stake => {
                total += stake.stake // Replace 'stake.stake' with the correct field name if different
            })

            return Hashing.sha256(total.toString()) // Ensure Hashing.sha256 is defined and works as expected
        } catch (e) {
            console.error("Error fetching GCR hashed stakes:", e)
        }
    }

    // INFO The following getter is used to retrieve the list of all validators at a given block
    static async getGCRValidatorsAtBlock(
        blockNumber: number = null,
    ): Promise<unknown[]> {
        const db = await Datasource.getInstance()
        const validatorsRepository = db
            .getDataSource()
            .getRepository(Validators)

        if (!blockNumber) {
            console.log("No block number provided, getting the last one")
            blockNumber = (await Chain.getLastBlock()).number // Ensure getLastBlock is also ported to TypeORM
        }
        console.log("blockNumber: " + blockNumber)

        try {
            const blockNodes = await validatorsRepository.find({
                where: {
                    valid_at: LessThanOrEqual(blockNumber),
                    status: "2",
                },
                order: { valid_at: "DESC" },
            })

            return blockNodes || []
        } catch (e) {
            console.error("Error fetching GCR validators at block:", e)
            return [] // or handle the error as needed
        }
    }

    // INFO Get a validator (or a public key anyway) status in the staking
    // NOTE While accepting a blockNumber, it defaults to the last one
    static async getGCRValidatorStatus(
        publicKeyHex: string,
        blockNumber: number = null,
    ) {
        const db = await Datasource.getInstance()
        const validatorsRepository = db
            .getDataSource()
            .getRepository(Validators)

        if (!blockNumber) {
            blockNumber = await Chain.getLastBlockNumber() // Ensure this method is also ported to TypeORM
        }

        try {
            const info = await validatorsRepository.findOne({
                where: {
                    first_seen: LessThanOrEqual(blockNumber),
                    address: publicKeyHex,
                },
            })

            return info || null
        } catch (e) {
            console.error("Error fetching validator status:", e)
            return null // or handle the error as needed
        }
    }

    // !SECTION Validators management

    // !SECTION Getters

    static async getGCRNativeStatus(address: string): Promise<GCRMain> {
        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

        let nativeStatus: GCRMain

        try {
            nativeStatus = await gcrMainRepository.findOne({
                where: { pubkey: address },
            })

            if (!nativeStatus) {
                nativeStatus = {
                    pubkey: address,
                    assignedTxs: [],
                    nonce: 0,
                    balance: BigInt(0),
                    identities: {
                        xm: {},
                        web2: {},
                    },
                }
            }
        } catch (e) {
            nativeStatus = {
                pubkey: address,
                assignedTxs: [],
                nonce: 0,
                balance: BigInt(0),
                identities: {
                    xm: {},
                    web2: {},
                },
            }
        }
        return nativeStatus
    }

    static async getGCRStatusProperties(address: string): Promise<GCRExtended> {
        const db = await Datasource.getInstance()
        const gcrRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)
        let statusProperties: GCRExtended
        try {
            const gcrSearch = await gcrRepository.findOneBy({
                publicKey: address,
            })
            statusProperties = gcrSearch?.extended
        } catch (e) {
            statusProperties = null
        }
        return statusProperties
    }

    // SECTION Setters
    // NOTE For consistency, setters should return a Promise<boolean>

    // INFO Assigning a XM Transaction to an address
    static async addToGCRXM(
        address: string,
        xmHash: string,
    ): Promise<OperationResult> {
        const result: OperationResult = {
            success: false,
            message: "",
        }
        try {
            let statusProperties: GCRExtended
            // Getting the table
            const db = await Datasource.getInstance()
            const gcrRepository = db
                .getDataSource()
                .getRepository(GlobalChangeRegistry)
            const gcrSearch = await gcrRepository.findOneBy({
                publicKey: address,
            })
            statusProperties = gcrSearch?.extended
            // Or creating it if it doesn't exist
            if (!statusProperties) {
                statusProperties = {
                    tokens: [],
                    nfts: [],
                    xm: [],
                    web2: [],
                    other: [],
                }
            }
            // Loading the object
            const jStatusProperties = statusProperties.xm
            jStatusProperties.push(xmHash)
            // And updating it
            statusProperties.xm = jStatusProperties
            await gcrRepository.update(
                { publicKey: address },
                { extended: statusProperties },
            )
            // REVIEW Save the hash of the GCR for this public key
            await gcrStateSave.updateGCRTracker(address)
            result.success = true
        } catch (e) {
            result.message = JSON.stringify(e)
        }
        return result
    }

    // INFO Assigning a Web2 Transaction to an address
    static async addToGCRWeb2(
        address: string,
        web2Hash: string,
    ): Promise<OperationResult> {
        const result: OperationResult = {
            success: false,
            message: "",
        }
        try {
            let statusProperties: any
            // Getting the table
            const db = await Datasource.getInstance()
            const gcrRepository = db
                .getDataSource()
                .getRepository(GlobalChangeRegistry)
            const gcrSearch = await gcrRepository.findOneBy({
                publicKey: address,
            })
            statusProperties = gcrSearch?.extended
            // Or creating it if it doesn't exist
            if (!statusProperties) {
                statusProperties = {
                    tokens: [],
                    nfts: [],
                    xm: [],
                    web2: [],
                    other: [],
                }
            }
            // Loading the object
            const jStatusProperties = JSON.parse(statusProperties.web2)
            jStatusProperties.push(web2Hash)
            // And updating it
            statusProperties.web2 = jStatusProperties
            await gcrRepository.update(
                { publicKey: address },
                { extended: statusProperties },
            )
            // REVIEW Save the hash of the GCR for this public key
            await gcrStateSave.updateGCRTracker(address)
            result.success = true
        } catch (e) {
            result.success = false
            result.message = JSON.stringify(e)
        }
        return result
    }

    // INFO Assigning a IMPData hash to an address or to the L1 itself
    static async addToGCRIMPData(
        address: string,
        impDataHash: string,
    ): Promise<OperationResult> {
        const result: OperationResult = {
            success: false,
            message: "",
        }
        // TODO Add stuff after loading the IMPData
        if (address == "demos") {
            // TODO Assigning to the blockchain
        }
        return result
    }

    static async setGCRNativeBalance(
        address: string,
        native: number,
        txHash: string,
    ): Promise<boolean> {
        const db = await Datasource.getInstance()
        const gcrRepository = db
            .getDataSource()
            .getRepository(GlobalChangeRegistry)

        try {
            let nativeStatus = await gcrRepository.findOne({
                select: ["details"],
                where: { publicKey: address },
            })

            if (!nativeStatus) {
                console.log("Creating new native status")
                nativeStatus = gcrRepository.create({
                    publicKey: address,
                    details: {
                        hash: "",
                        content: {
                            balance: 0,
                            identities: {
                                xm: {},
                                web2: {},
                            },
                            txs: [],
                            nonce: 0,
                        },
                    },
                })
                await gcrRepository.save(nativeStatus)
            }

            //console.log(nativeStatus.details.txs)
            const txList = nativeStatus.details.content.txs || []
            txList.push(txHash)

            await gcrRepository.update(
                { publicKey: address },
                {
                    details: {
                        hash: "",
                        content: {
                            balance: native,
                            txs: txList,
                            nonce: nativeStatus.details.content.nonce,
                        },
                    },
                },
            )

            //console.log(tx_list)
            // TODO: Decide if we should use status_hashes too
            // Note: The original function returns responses from Chain.write, consider what you need to return here.
            return true // Adjust the return value as needed based on your requirements.
        } catch (e) {
            console.error("Error setting GCR native balance:", e)
            console.log("[GCR ERROR: NATIVE] ")
            console.log(e)
            return false
        }
    }

    // TODO Build objects for tokens and nfts and write setters for them

    // !SECTION Setters
}
