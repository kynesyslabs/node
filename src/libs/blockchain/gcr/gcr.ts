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
import { In, LessThan, LessThanOrEqual, Not } from "typeorm"

import {
    Operation,
    OperationRegistrySlot,
    OperationResult,
    RPCResponse,
} from "@kynesyslabs/demosdk/types"

import Chain from "../chain"
import executeOperations, { Actor } from "../routines/executeOperations"
import gcrStateSave from "./gcr_routines/gcrStateSaverHelper"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { Referrals } from "@/features/incentive/referrals"
import log from "@/utilities/logger"
import { skeletons } from "@kynesyslabs/demosdk/websdk"
import { getSharedState } from "@/utilities/sharedState"
import { ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import HandleGCR from "./handleGCR"
import Mempool from "../mempool_v2"

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

    static async getAccountByIdentity(identity: {
        type: "web2" | "xm"
        // web2
        context?: "twitter" | "telegram" | "github" | "discord"
        username?: string
        userId?: string
        // xm
        chain?: string // eg. "eth.mainnet" | "solana.mainnet", etc.
        address?: string
    }): Promise<GCRMain[]> {
        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

        if (!identity || !identity.type) {
            return null
        }

        if (identity.type === "web2") {
            if (!identity.context || (!identity.username && !identity.userId)) {
                return null
            }

            // Find accounts that have the specified web2 identity (by username or userId)
            const accounts = await gcrMainRepository
                .createQueryBuilder("gcr")
                .where(
                    identity.userId
                        ? "EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(gcr.identities->'web2'->:context, '[]'::jsonb)) AS w2 WHERE w2->>'userId' = :userId)"
                        : "EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(gcr.identities->'web2'->:context, '[]'::jsonb)) AS w2 WHERE w2->>'username' = :username)",
                    identity.userId
                        ? { context: identity.context, userId: identity.userId }
                        : {
                              context: identity.context,
                              username: identity.username,
                          },
                )
                .getMany()

            return accounts
        }

        if (identity.type === "xm") {
            if (!identity.chain || !identity.address) {
                return null
            }

            let [chain, subchain] = identity.chain.split(".")
            if (!chain || !subchain) {
                return null
            }

            // Replace "eth" with "evm"
            if (chain === "eth") {
                chain = "evm"
            }

            // Find accounts that have the specified web3 wallet address under the specific chain/subchain
            const accounts = await gcrMainRepository
                .createQueryBuilder("gcr")
                .where(
                    "EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(gcr.identities->'xm'->:chain->:subchain, '[]'::jsonb)) AS xm_id WHERE lower(xm_id->>'address') = lower(:address))",
                    { chain, subchain, address: identity.address },
                )
                .getMany()

            return accounts
        }

        return null
    }

    static async getCampaignData() {
        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)
        const allUsers = await gcrMainRepository.find({
            where: {
                balance: LessThan(BigInt(1000000000000)),
                flaggedReason: Not(
                    In(["manualFlag", "referrerFlagged", "twitter_bot"]),
                ),
            },
        })

        const twitterUsers = new Set()

        const campaignData = {
            users: {
                total: 0,
                withTwitter: {
                    total: 0,
                    followDemos: 0,
                },
                withWeb3Wallet: 0,
                fromReferral: 0,
            },
            points: {
                total: 0,
                twitter: 0,
                web3Wallets: 0,
                accountsWithTwitterTotal: 0,
                referrals: 0,
                demosFollow: 0,
                demTotal: 0,
                accountsWithTwitterDemTotal: 0,
            },
            evmAccounts: 0,
            solanaAccounts: 0,
        }

        for (const user of allUsers) {
            campaignData.users.total++
            campaignData.points.total += user.points.totalPoints
            campaignData.points.twitter +=
                user.points.breakdown.socialAccounts.twitter
            campaignData.points.referrals +=
                user.points.breakdown.referrals || 0
            campaignData.points.demosFollow +=
                user.points.breakdown.demosFollow || 0

            const web3WalletPoints = Object.values(
                user.points.breakdown.web3Wallets,
            ).reduce(function (acc, curr) {
                return acc + curr
            }, 0)

            campaignData.points.web3Wallets += web3WalletPoints
            campaignData.users.withWeb3Wallet += web3WalletPoints ? 1 : 0

            if (user.identities.web2.twitter) {
                campaignData.points.accountsWithTwitterTotal +=
                    user.points.totalPoints || 0
                for (const twitterAccount of user.identities.web2.twitter) {
                    twitterUsers.add(twitterAccount.userId)
                    campaignData.users.withTwitter.followDemos += user.points
                        .breakdown.demosFollow
                        ? 1
                        : 0
                }
            }

            if (user.identities.xm["evm"]) {
                for (const evmAccount of Object.keys(
                    user.identities.xm["evm"],
                )) {
                    campaignData.evmAccounts++
                }
            }

            if (user.identities.xm["solana"]) {
                campaignData.solanaAccounts++
            }

            if (user.referralInfo && user.referralInfo.referredBy) {
                campaignData.users.fromReferral++
            }
        }

        campaignData.users.withTwitter.total = twitterUsers.size
        campaignData.points.demTotal = campaignData.points.total * 30
        campaignData.points.accountsWithTwitterDemTotal =
            campaignData.points.accountsWithTwitterTotal * 30

        return campaignData
    }

    static async getAddressesByTwitterUsernames(twitterUsernames: string[]) {
        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

        if (!twitterUsernames || twitterUsernames.length === 0) {
            return {}
        }

        // Query accounts that have Twitter identities with usernames in the provided array
        const accounts = await gcrMainRepository
            .createQueryBuilder("gcr")
            .where(
                "EXISTS (SELECT 1 FROM jsonb_array_elements(gcr.identities->'web2'->'twitter') as twitter_id WHERE twitter_id->>'username' = ANY(:usernames))",
                { usernames: twitterUsernames },
            )
            .getMany()

        const usernameToAddressMap: Record<string, string> = {}

        for (const account of accounts) {
            // Check if the account has zero Twitter points (means Twitter was already connected elsewhere)
            if (account.points?.breakdown?.socialAccounts?.twitter === 0) {
                console.log(
                    `Skipping account ${account.pubkey} - Twitter already connected to another account`,
                )
                continue
            }

            // Find Twitter identities that match the provided usernames
            const twitterIdentities = account.identities.web2?.twitter || []

            for (const twitterIdentity of twitterIdentities) {
                if (twitterUsernames.includes(twitterIdentity.username)) {
                    usernameToAddressMap[twitterIdentity.username] =
                        account.pubkey
                }
            }
        }

        return usernameToAddressMap
    }

    /**
     * Create a transaction to award points to the users
     * @param twitterUsernames List of twitter usernames to award points to
     *
     */
    static async createAwardPointsTransaction(
        twitterUsernames: {
            /**
             * The username of the user to award points to
             */
            username: string
            /**
             * The amount of points to award
             */
            points: number
        }[],
    ) {
        const awardDate = new Date().toISOString()
        const addresses = await this.getAddressesByTwitterUsernames(
            twitterUsernames.map(u => u.username),
        )

        const edits = []

        for (const account of twitterUsernames as any) {
            if (addresses[account.username]) {
                edits.push({
                    type: "identity",
                    context: "points",
                    isRollback: false,
                    operation: "add",
                    account: addresses[account.username],
                    amount: Number(account.points),
                    date: awardDate,
                    txhash: "",
                })
                account.address = addresses[account.username]
                account.comment = "Account found"
            } else {
                account.address = null
                account.comment = "Account not found"
            }
        }

        const tx = structuredClone(skeletons.transaction)
        tx.content.type = "identity"
        tx.content.from = getSharedState.publicKeyHex
        tx.content.to = getSharedState.publicKeyHex
        tx.content.from_ed25519_address = getSharedState.publicKeyHex
        tx.content.gcr_edits = edits
        tx.content.nonce = 1
        tx.content.timestamp = Date.now()
        tx.content.amount = 0
        // @ts-expect-error This is a custom tx type
        tx.content.data = ["awardPoints", twitterUsernames]
        tx.hash = Hashing.sha256(JSON.stringify(tx.content))

        const signature = await ucrypto.sign(
            getSharedState.signingAlgorithm,
            new TextEncoder().encode(tx.hash),
        )
        tx.signature = {
            type: getSharedState.signingAlgorithm,
            data: uint8ArrayToHex(signature.signature),
        }

        console.log("tx", JSON.stringify(tx, null, 2))
        return tx
    }

    /**
     * Get top accounts by points with their Web3 addresses
     * @param limit Maximum number of accounts to return (default: 100)
     * @returns RPCResponse with top accounts and their blockchain addresses
     */
    static async getTopAccountsByPoints(limit = 100): Promise<RPCResponse> {
        try {
            const db = await Datasource.getInstance()
            const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

            // Query top accounts by points, excluding flagged accounts
            const accounts = await gcrMainRepository
                .createQueryBuilder("gcr")
                .where("gcr.flagged = :flagged", { flagged: false })
                .orderBy(
                    "(gcr.points->>'totalPoints')::numeric",
                    "DESC",
                    "NULLS LAST",
                )
                .limit(limit)
                .getMany()

            // Transform to simplified structure with only pubkey and Web3 addresses
            const formattedAccounts = accounts.map((account, index) => {
                // Extract Ethereum addresses from xm.evm.mainnet
                const ethereumAddresses =
                    account.identities?.xm?.evm?.mainnet?.map(
                        identity => identity.address,
                    ) || []

                // Extract Solana addresses from xm.solana.mainnet
                const solanaAddresses =
                    account.identities?.xm?.solana?.mainnet?.map(
                        identity => identity.address,
                    ) || []

                return {
                    pubkey: account.pubkey,
                    rank: index + 1,
                    totalPoints: account.points?.totalPoints || 0,
                    breakdown: account.points?.breakdown || {},
                    ethereumAddresses,
                    solanaAddresses,
                }
            })

            return {
                result: 200,
                response: {
                    success: true,
                    accounts: formattedAccounts,
                    count: formattedAccounts.length,
                    limit,
                },
                extra: null,
                require_reply: false,
            }
        } catch (error) {
            log.error("Error fetching top accounts by points:" + error)
            return {
                result: 500,
                response: {
                    success: false,
                    error: "Failed to fetch top accounts",
                    message:
                        error instanceof Error
                            ? error.message
                            : "Unknown error",
                },
                extra: null,
                require_reply: false,
            }
        }
    }

    /**
     * @param twitterUsernames List of twitter usernames to award points to
     * @returns Array of usernames that were successfully awarded points
     */
    static async awardPoints(
        twitterUsernames: {
            username: string
            points: number
        }[],
    ): Promise<{
        success: boolean
        error?: string
        message: string
        txhash?: string
        confirmationBlock: number
    }> {
        if (!twitterUsernames || twitterUsernames.length === 0) {
            console.log("No Twitter usernames provided")
            return {
                success: false,
                message: "No Twitter usernames provided",
                confirmationBlock: null,
            }
        }

        // INFO: Make sure each twitter username has valid points
        for (const account of twitterUsernames) {
            const points = Number(account.points)
            if (isNaN(points) || points <= 0) {
                return {
                    success: false,
                    message:
                        "Failed: Invalid input. Point value must be a number greater than 0.",
                    confirmationBlock: null,
                }
            }
        }

        const tx = await this.createAwardPointsTransaction(twitterUsernames)

        const editResults = await HandleGCR.applyToTx(
            structuredClone(tx),
            false,
            true,
        )

        if (!editResults.success) {
            console.log("Failed to apply GCREdit")
            return {
                success: false,
                message: "Failed to apply transaction",
                confirmationBlock: null,
            }
        }

        const { confirmationBlock, error } = await Mempool.addTransaction({
            ...tx,
            reference_block: await Chain.getLastBlockNumber(),
        })

        if (error) {
            console.log("Failed to add transaction to mempool")
            return {
                success: false,
                message: "Failed to add transaction to mempool",
                confirmationBlock: null,
            }
        }

        return {
            success: true,
            message: "Points awarded",
            txhash: tx.hash,
            confirmationBlock,
        }

        // const db = await Datasource.getInstance()
        // const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

        // // Query accounts that have Twitter identities with usernames in the provided array
        // const accounts = await gcrMainRepository
        //     .createQueryBuilder("gcr")
        //     .where(
        //         "EXISTS (SELECT 1 FROM jsonb_array_elements(gcr.identities->'web2'->'twitter') as twitter_id WHERE twitter_id->>'username' = ANY(:usernames))",
        //         { usernames: twitterUsernames },
        //     )
        //     .getMany()

        // let awardedCount = 0
        // let skippedCount = 0
        // const awardedAccounts: Record<string, string>[] = []

        // for (const account of accounts) {
        //     // Check if the account has zero Twitter points (means Twitter was already connected elsewhere)
        //     if (account.points?.breakdown?.socialAccounts?.twitter === 0) {
        //         console.log(
        //             `Skipping account ${account.pubkey} - Twitter already connected to another account`,
        //         )
        //         skippedCount++
        //         continue
        //     }

        //     // Initialize weeklyChallenge if it doesn't exist
        //     if (!account.points.breakdown.weeklyChallenge) {
        //         account.points.breakdown.weeklyChallenge = []
        //     }

        //     // Add the weekly challenge point
        //     const challengeEntry = {
        //         date: new Date().toISOString(),
        //         points: 1,
        //     }

        //     account.points.breakdown.weeklyChallenge.push(challengeEntry)
        //     account.points.totalPoints = (account.points.totalPoints || 0) + 1
        //     account.points.lastUpdated = new Date()

        //     // Get Twitter username that matches the provided list
        //     const twitterIdentity = account.identities.web2?.twitter?.find(
        //         (twitter: any) => twitterUsernames.includes(twitter.username),
        //     )

        //     // Save the account
        //     await gcrMainRepository.save(account)
        //     awardedCount++

        //     // Add to successful usernames list
        //     if (twitterIdentity?.username) {
        //         awardedAccounts.push({
        //             username: twitterIdentity.username,
        //             pubkey: account.pubkey,
        //         })
        //     }
        // }

        // return awardedAccounts
    }

    // static async getFlaggedAccounts(start: number, end: number) {
    //     const db = await Datasource.getInstance()
    //     const gcrMainRepository = db.getDataSource().getRepository(GCRMain)
    //     const flaggedAccounts = await gcrMainRepository.find({
    //         where: { flagged: true },
    //         order: { pubkey: "ASC" },
    //         skip: start,
    //         take: end - start,
    //     })

    //     return flaggedAccounts
    // }

    // static async removeAccount(address: string) {
    //     const db = await Datasource.getInstance()
    //     const gcrMainRepository = db.getDataSource().getRepository(GCRMain)
    //     return await gcrMainRepository.delete({ pubkey: address })
    // }

    // static async unflagAccount(address: string) {
    //     const db = await Datasource.getInstance()
    //     const gcrMainRepository = db.getDataSource().getRepository(GCRMain)
    //     return await gcrMainRepository.update(
    //         { pubkey: address },
    //         { flagged: false, flaggedReason: "", reviewed: true },
    //     )
    // }

    // TODO Build objects for tokens and nfts and write setters for them

    // !SECTION Setters
}
