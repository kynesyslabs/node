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

import _ from "lodash"
import { In, LessThan, LessThanOrEqual, Not } from "typeorm"

import Hashing from "src/libs/crypto/hashing"
import Datasource from "src/model/datasource"

import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "../chain"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import log from "@/utilities/logger"
import { skeletons } from "@kynesyslabs/demosdk/websdk"
import { getSharedState } from "@/utilities/sharedState"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import HandleGCR from "./handleGCR"
import Mempool from "../mempool"
import { serializeTransactionContent } from "@/forks"
import TxValidatorPool from "../validation/txValidatorPool"
import { GCRSubnetsTxs } from "@/model/entities/GCRv2/GCRSubnetsTxs"
import { emptyResponse } from "@/libs/network"
import { Validators } from "@/model/entities/Validators"
import {
    IDENTITIES_DEFAULT_LIMIT,
    IDENTITIES_MAX_LIMIT,
} from "@/utilities/constants"

export type GetNativeSubnetsTxsOptions = {
    txData?: boolean
}

interface Web2AccountParams {
    username: string
    platform: "twitter" | "discord" | "telegram" | "github"
}

interface XMAccountParams {
    chain: `${string}.${string}` // eg. "eth.mainnet" | "solana.mainnet", etc.
    address: string
}

interface NativeAccountParams {
    address: string
}

export type AccountParams = (
    | Web2AccountParams
    | XMAccountParams
    | NativeAccountParams
) & {
    points: number
}

// Type guard functions
function isWeb2Account(
    account: AccountParams,
): account is Web2AccountParams & { points: number } {
    return "platform" in account && "username" in account
}

function isXmAccount(
    account: AccountParams,
): account is XMAccountParams & { points: number } {
    return "chain" in account && "address" in account && !!account.chain
}

function isNativeAccount(
    account: AccountParams,
): account is NativeAccountParams & { points: number } {
    return "address" in account && !("chain" in account)
}

export default class GCR {
    // ANCHOR Balances retrieval

    /**
     *
     * @param pubkey Get the balance of a GCR account
     * @returns The balance of the account
     */
    static async getAccountBalance(pubkey: string): Promise<bigint> {
        const db = await Datasource.getInstance()
        const gcrRepository = db.getDataSource().getRepository(GCRMain)

        try {
            const account = await gcrRepository.findOne({
                where: { pubkey },
                select: ["balance"],
            })

            return account ? BigInt(account.balance) : 0n
        } catch (e) {
            log.debug(`[GET BALANCE] No balance for: ${pubkey}`)
            return 0n
        }
    }

    static async getGCRLastBlockBaseGas(): Promise<number> {
        // TODO Implement and make it dynamic
        return 1
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

            let total = 0n
            for (const v of stakes) {
                const raw = v.staked_amount ?? "0"
                try {
                    total += BigInt(raw)
                } catch {
                    log.warning(
                        "GCR",
                        `getGCRHashedStakes: dropping malformed staked_amount=${raw} on validator ${v.address}`,
                    )
                }
            }

            return Hashing.sha256(total.toString())
        } catch (e) {
            log.error(`Error fetching GCR hashed stakes: ${e}`)
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
            log.debug("No block number provided, getting the last one")
            blockNumber = (await Chain.getLastBlock()).number // Ensure getLastBlock is also ported to TypeORM
        }
        log.debug(`blockNumber: ${blockNumber}`)

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
            log.error(`Error fetching GCR validators at block: ${e}`)
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
            log.error(`Error fetching validator status: ${e}`)
            return null // or handle the error as needed
        }
    }

    static async getNativeSubnetsTxs(
        subnetId: string,
        options: GetNativeSubnetsTxsOptions = {
            txData: true,
        },
    ): Promise<RPCResponse> {
        const response: RPCResponse = _.cloneDeep(emptyResponse)
        const db = await Datasource.getInstance()
        const gcrSubnetsTxsRepository = db
            .getDataSource()
            .getRepository(GCRSubnetsTxs)
        // Getting the status subnets txs data
        const gcrSubnetsTxsSearch = await gcrSubnetsTxsRepository.findBy({
            subnet_id: subnetId,
        })
        if (!gcrSubnetsTxsSearch) {
            response.response = "Subnet not found"
            response.result = 404
            return response
        }
        // Preparing the response
        const gcrSubnetsTxsData: GCRSubnetsTxs[] = []
        // Selecting only the requested data
        if (!options.txData) {
            for (const tx of gcrSubnetsTxsSearch) {
                tx.tx_data = null
                gcrSubnetsTxsData.push(tx)
            }
        }
        response.response = gcrSubnetsTxsData
        return response
    }

    static async getAccountByTwitterUsername(username: string) {
        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

        // INFO: Find all accounts that have the twitter identity with the given username using a jsonb query
        const accounts = await gcrMainRepository
            .createQueryBuilder("gcr")
            .where(
                "EXISTS (SELECT 1 FROM jsonb_array_elements(gcr.identities->'web2'->'twitter') as twitter_id WHERE twitter_id->>'username' = :username)",
                { username },
            )
            .getMany()

        // If no accounts found, return null
        if (accounts.length === 0) {
            return null
        }

        // If only one account found, return it
        if (accounts.length === 1) {
            return accounts[0]
        }

        // If multiple accounts found, find the one that was awarded points
        // (Twitter points > 0 means the account was awarded points)
        const accountWithPoints = accounts.find(
            account => account.points?.breakdown?.socialAccounts?.twitter > 0,
        )

        // Return the account with points if found, otherwise return the first account
        return accountWithPoints || accounts[0]
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

            // eslint-disable-next-line prefer-const
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

    // static async getAccountByTelegramUsername(username: string) {
    //     const db = await Datasource.getInstance()
    //     const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

    //     // INFO: Find all accounts that have the telegram identity with the given username using a jsonb query
    //     const accounts = await gcrMainRepository
    //         .createQueryBuilder("gcr")
    //         .where(
    //             "EXISTS (SELECT 1 FROM jsonb_array_elements(gcr.identities->'web2'->'telegram') as telegram_id WHERE telegram_id->>'username' = :username)",
    //             { username },
    //         )
    //         .getMany()

    //     // If no accounts found, return null
    //     if (accounts.length === 0) {
    //         return null
    //     }

    //     // If only one account found, return it
    //     if (accounts.length === 1) {
    //         return accounts[0]
    //     }

    //     // If multiple accounts found, find the one that was awarded points
    //     // (Telegram points > 0 means the account was awarded points)
    //     const accountWithPoints = accounts.find(
    //         account => account.points?.breakdown?.socialAccounts?.telegram > 0,
    //     )

    //     // Return the account with points if found, otherwise return the first account
    //     return accountWithPoints || accounts[0]
    // }

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

    static async getAddressesByWeb2Usernames(
        queries: {
            platform: "twitter" | "discord" | "telegram" | "github"
            username: string
        }[],
    ): Promise<Record<string, string>> {
        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

        if (!queries || queries.length === 0) {
            return {}
        }

        // Group queries by platform for efficient batch queries
        const queriesByPlatform: Record<
            string,
            { platform: string; username: string }[]
        > = {}
        for (const query of queries) {
            if (!queriesByPlatform[query.platform]) {
                queriesByPlatform[query.platform] = []
            }
            queriesByPlatform[query.platform].push(query)
        }

        const usernameToAddressMap: Record<string, string> = {}

        // Process each platform separately
        for (const [platform, platformQueries] of Object.entries(
            queriesByPlatform,
        )) {
            const usernames = platformQueries.map(q => q.username)

            // Query accounts that have identities with usernames in the provided array for this platform
            const accounts = await gcrMainRepository
                .createQueryBuilder("gcr")
                .where(
                    "EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(gcr.identities->'web2'->:platform, '[]'::jsonb)) as platform_id WHERE platform_id->>'username' = ANY(:usernames))",
                    { platform, usernames },
                )
                .getMany()

            for (const account of accounts) {
                // Check if the account has zero points for this platform (means account was already connected elsewhere)
                const platformPoints =
                    account.points?.breakdown?.socialAccounts?.[platform]
                if (platformPoints === 0) {
                    log.debug(
                        `Skipping account ${account.pubkey} - ${platform} already connected to another account`,
                    )
                    continue
                }

                // Find identities that match the provided usernames for this platform
                const platformIdentities =
                    account.identities.web2?.[platform] || []

                for (const identity of platformIdentities) {
                    if (usernames.includes(identity.username)) {
                        // Use platform:username as key to avoid collisions between platforms
                        usernameToAddressMap[
                            `${platform}:${identity.username}`
                        ] = account.pubkey
                    }
                }
            }
        }

        return usernameToAddressMap
    }

    static async getAddressesByNativeAddresses(
        addresses: string[],
    ): Promise<Record<string, string>> {
        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

        if (!addresses || addresses.length === 0) {
            return {}
        }

        // Query accounts by pubkey directly
        const accounts = await gcrMainRepository
            .createQueryBuilder("gcr")
            .where("gcr.pubkey = ANY(:addresses)", { addresses })
            .getMany()

        const addressToPubkeyMap: Record<string, string> = {}

        for (const account of accounts) {
            if (addresses.includes(account.pubkey)) {
                addressToPubkeyMap[account.pubkey] = account.pubkey
            }
        }

        return addressToPubkeyMap
    }

    static async getAddressesByXmAccounts(
        queries: {
            chain: string
            address: string
        }[],
    ): Promise<Record<string, string>> {
        const db = await Datasource.getInstance()
        const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

        if (!queries || queries.length === 0) {
            return {}
        }

        // Group queries by chain for efficient batch queries
        const queriesByChain: Record<
            string,
            {
                chain: string
                subchain: string
                address: string
                originalChain: string
            }[]
        > = {}

        for (const query of queries) {
            // Split chain.subchain format (e.g., "eth.mainnet" -> chain="evm", subchain="mainnet")
            const [chainPart, subchainPart] = query.chain.split(".")
            if (!chainPart || !subchainPart) {
                continue
            }

            // Replace "eth" with "evm" (as done in getAccountByIdentity)
            let chain = chainPart
            if (chain === "eth") {
                chain = "evm"
            }
            const subchain = subchainPart

            const chainKey = `${chain}.${subchain}`
            if (!queriesByChain[chainKey]) {
                queriesByChain[chainKey] = []
            }
            queriesByChain[chainKey].push({
                chain,
                subchain,
                address: query.address,
                originalChain: query.chain,
            })
        }

        const addressToPubkeyMap: Record<string, string> = {}

        // Helper function to determine if a chain is EVM-based (case-insensitive addresses)
        const isEvmChain = (chainName: string): boolean => {
            return chainName === "evm" || chainName === "eth"
        }

        // Process each chain separately
        for (const [chainKey, chainQueries] of Object.entries(queriesByChain)) {
            const [chain, subchain] = chainKey.split(".") as [string, string]
            const isEvm = isEvmChain(chain)
            const addresses = chainQueries.map(q => q.address)

            // Build query based on chain type - EVM addresses are case-insensitive, others are case-sensitive
            let queryString: string
            let queryAddresses: string[]

            if (isEvm) {
                // EVM addresses: use lowercase comparison
                queryString =
                    "EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(gcr.identities->'xm'->:chain->:subchain, '[]'::jsonb)) AS xm_id WHERE lower(xm_id->>'address') = ANY(:addresses))"
                queryAddresses = addresses.map(addr => addr.toLowerCase())
            } else {
                // Non-EVM addresses (e.g., Solana): case-sensitive comparison
                queryString =
                    "EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(gcr.identities->'xm'->:chain->:subchain, '[]'::jsonb)) AS xm_id WHERE xm_id->>'address' = ANY(:addresses))"
                queryAddresses = addresses
            }

            // Query accounts that have the specified web3 wallet address under the specific chain/subchain
            const accounts = await gcrMainRepository
                .createQueryBuilder("gcr")
                .where(queryString, {
                    chain,
                    subchain,
                    addresses: queryAddresses,
                })
                .getMany()

            for (const account of accounts) {
                // Find identities that match the provided addresses for this chain/subchain
                const xmIdentities =
                    account.identities.xm?.[chain]?.[subchain] || []

                for (const identity of xmIdentities) {
                    for (const query of chainQueries) {
                        // Compare addresses based on chain type
                        let matches = false
                        if (isEvm) {
                            // EVM: case-insensitive comparison
                            matches =
                                identity.address.toLowerCase() ===
                                query.address.toLowerCase()
                        } else {
                            // Non-EVM (e.g., Solana): case-sensitive comparison
                            matches = identity.address === query.address
                        }

                        if (matches) {
                            // Use originalChain:address as key to match what caller expects
                            addressToPubkeyMap[
                                `${query.originalChain}:${query.address}`
                            ] = account.pubkey
                        }
                    }
                }
            }
        }

        return addressToPubkeyMap
    }

    /**
     * Create a transaction to award points to the users
     * @param accounts List of accounts to award points to (supports web2 platforms, native addresses, and web3 accounts)
     *
     */
    static async createAwardPointsTransaction(accounts: AccountParams[]) {
        const awardDate = new Date().toISOString()

        // Separate accounts by type
        const web2Accounts = accounts.filter(isWeb2Account)
        const nativeAccounts = accounts.filter(isNativeAccount)
        const xmAccounts = accounts.filter(isXmAccount)

        // Resolve addresses for each account type
        const web2Addresses = await this.getAddressesByWeb2Usernames(
            web2Accounts.map(a => ({
                platform: a.platform,
                username: a.username,
            })),
        )

        const nativeAddresses = await this.getAddressesByNativeAddresses(
            nativeAccounts.map(a => a.address),
        )

        const xmAddresses = await this.getAddressesByXmAccounts(
            xmAccounts.map(a => ({
                chain: a.chain,
                address: a.address,
            })),
        )

        // Merge all address maps
        const allAddresses = {
            ...web2Addresses,
            ...nativeAddresses,
            ...xmAddresses,
        }

        const edits = []

        for (const account of accounts as any) {
            let addressKey: string
            let lookupValue: string

            if (isWeb2Account(account)) {
                addressKey = `${account.platform}:${account.username}`
                lookupValue = `web2.${account.platform}.${account.username}`
            } else if (isNativeAccount(account)) {
                addressKey = account.address
                lookupValue = `native.${account.address}`
            } else if (isXmAccount(account)) {
                addressKey = `${account.chain}:${account.address}`
                lookupValue = `web3.${account.chain}.${account.address}`
            } else {
                continue
            }

            // Set lookup property and remove original properties
            const accountAny = account as any
            accountAny.lookup = lookupValue

            // Remove original lookup properties
            delete accountAny.username
            delete accountAny.platform
            delete accountAny.chain

            if (allAddresses[addressKey]) {
                edits.push({
                    type: "identity",
                    context: "points",
                    isRollback: false,
                    operation: "add",
                    account: allAddresses[addressKey],
                    amount: Number(account.points),
                    date: awardDate,
                    txhash: "",
                })
                accountAny.address = allAddresses[addressKey]
                accountAny.comment = "Account found. Points awarded."
            } else {
                accountAny.address = null
                accountAny.comment = "Account not found. Points NOT awarded."
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
        tx.content.data = ["awardPoints", accounts]
        // REVIEW: P2 — fork-aware serialization for the awardPoints tx hash.
        // The chain head is the correct reference; this tx is created at
        // runtime, not bound to a specific block.
        const referenceHeight = await Chain.getLastBlockNumber()
        tx.hash = Hashing.sha256(
            serializeTransactionContent(tx.content, referenceHeight),
        )

        const signature = await TxValidatorPool.getInstance().sign(
            getSharedState.signingAlgorithm,
            new TextEncoder().encode(tx.hash),
        )
        tx.signature = {
            type: getSharedState.signingAlgorithm,
            data: uint8ArrayToHex(signature.signature),
        }

        log.debug("tx: " + JSON.stringify(tx))
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
     * @param accounts List of accounts to award points to (supports multiple web2 platforms)
     * @returns Result of the award points operation
     */
    static async awardPoints(accounts: AccountParams[]): Promise<{
        success: boolean
        error?: string
        message: string
        txhash?: string
        confirmationBlock: number
    }> {
        if (!accounts || accounts.length === 0) {
            log.warning("No accounts provided")
            return {
                success: false,
                message: "No accounts provided",
                confirmationBlock: null,
            }
        }

        // INFO: Validate each account based on its type
        for (const account of accounts) {
            // INFO: Make sure each account has valid points
            const points = Number(account.points)
            if (isNaN(points) || points <= 0) {
                const accountIdentifier = isWeb2Account(account)
                    ? account.username
                    : isXmAccount(account)
                      ? `${account.chain}:${account.address}`
                      : account.address
                return {
                    success: false,
                    message:
                        "Failed: Invalid input. Point value must be a number greater than 0. Account: " +
                        accountIdentifier,
                    confirmationBlock: null,
                }
            }

            // INFO: Validate account type-specific fields
            if (isWeb2Account(account)) {
                if (!account.platform) {
                    return {
                        success: false,
                        message:
                            "Failed: Platform is not specified for account " +
                            account.username,
                        confirmationBlock: null,
                    }
                }
                // INFO: remove @ prefix for web2 accounts
                if (account.username.startsWith("@")) {
                    account.username = account.username.slice(1)
                }
            } else if (isXmAccount(account)) {
                if (!account.chain || !account.address) {
                    return {
                        success: false,
                        message:
                            "Failed: Chain and address must be specified for web3 account",
                        confirmationBlock: null,
                    }
                }
                // Validate chain.subchain format
                const [chain, subchain] = account.chain.split(".")
                if (!chain || !subchain) {
                    return {
                        success: false,
                        message:
                            "Failed: Chain must be in format 'chain.subchain' (e.g., 'eth.mainnet')",
                        confirmationBlock: null,
                    }
                }
                // Normalize eth.subchain to evm.subchain (eth is stored as evm in DB)
                if (chain === "eth") {
                    account.chain = `evm.${subchain}` as `${string}.${string}`
                }
            } else if (isNativeAccount(account)) {
                if (!account.address) {
                    return {
                        success: false,
                        message:
                            "Failed: Address must be specified for native account",
                        confirmationBlock: null,
                    }
                }
            }
        }

        const tx = await this.createAwardPointsTransaction(accounts)

        const entities = await HandleGCR.prepareEntities([tx])
        const simulateResult = await HandleGCR.applyTransaction(
            entities,
            tx,
            false,
            true,
        )

        if (!simulateResult.success) {
            log.error("Failed to apply GCREdit")
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
            log.error("Failed to add transaction to mempool")
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

    /**
     * List the linked identities of every account, paginated.
     *
     * Returns only `pubkey` + the `identities` jsonb blob per account —
     * never balance/nonce/points — so the payload stays focused and the
     * `bigint` balance column (which `JSON.stringify` cannot serialize) is
     * never touched.
     *
     * Pagination is keyset (a.k.a. seek) on the `pubkey` primary key, not
     * offset: each page seeks `WHERE pubkey > :cursor ORDER BY pubkey ASC
     * LIMIT :n`, which stays O(log n) on the PK index regardless of how
     * deep into the table the caller is. The `gcr_main` table can hold a
     * large number of jsonb-heavy rows, so an unbounded `find()` is
     * deliberately avoided here.
     *
     * @param limit  Max rows per page. Clamped to [1, 1000]. Default 100.
     * @param cursor The `pubkey` of the last row from the previous page.
     *               Omit for the first page.
     * @returns `RPCResponse` whose `response` is
     *   `{ success, identities: [{ pubkey, identities }], count, limit, nextCursor }`.
     *   `nextCursor` is the last `pubkey` of this page when a full page was
     *   returned (more rows may exist), or `null` when the end was reached.
     */
    static async listIdentities(
        limit = 100,
        cursor?: string,
    ): Promise<RPCResponse> {
        try {
            // Clamp the page size into a sane bound. A non-numeric or
            // non-positive limit falls back to the default; the hard cap
            // protects the node from a single huge response.
            const DEFAULT_LIMIT = IDENTITIES_DEFAULT_LIMIT
            const MAX_LIMIT = IDENTITIES_MAX_LIMIT
            const parsedLimit = Number(limit)
            // Floor of a fractional limit in (0, 1) is 0, which would request
            // an empty page; clamp to a minimum of 1 so pageSize is always a
            // positive integer.
            const pageSize =
                Number.isFinite(parsedLimit) && parsedLimit > 0
                    ? Math.max(1, Math.min(Math.floor(parsedLimit), MAX_LIMIT))
                    : DEFAULT_LIMIT

            const db = await Datasource.getInstance()
            const gcrMainRepository = db.getDataSource().getRepository(GCRMain)

            const qb = gcrMainRepository
                .createQueryBuilder("gcr")
                .select(["gcr.pubkey", "gcr.identities"])
                .orderBy("gcr.pubkey", "ASC")
                .limit(pageSize)

            // Keyset seek: only rows strictly after the cursor pubkey.
            if (cursor) {
                qb.where("gcr.pubkey > :cursor", { cursor })
            }

            const accounts = await qb.getMany()

            const identities = accounts.map(account => ({
                pubkey: account.pubkey,
                identities: account.identities,
            }))

            // A full page means there may be more rows; hand back the last
            // pubkey as the next cursor. A short page is the end of the table.
            const nextCursor =
                identities.length === pageSize && identities.length > 0
                    ? identities[identities.length - 1].pubkey
                    : null

            return {
                result: 200,
                response: {
                    success: true,
                    identities,
                    count: identities.length,
                    limit: pageSize,
                    nextCursor,
                },
                extra: null,
                require_reply: false,
            }
        } catch (error) {
            log.error("Error listing identities: " + error)
            return {
                result: 500,
                response: {
                    success: false,
                    error: "Failed to list identities",
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
