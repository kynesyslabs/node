import { AnchorProvider, Program } from "@coral-xyz/anchor"
import Wallet from "@coral-xyz/anchor/dist/cjs/nodewallet"
import { PublicKey, Connection, Keypair, type Commitment, clusterApiUrl } from "@solana/web3.js"
import { createHash } from "crypto"
import UnsSolIdl from "../../UDTypes/uns_sol.json" with { type: "json" }
import { UnsSol } from "../../UDTypes/uns_sol"
import log from "src/utilities/logger"
import { chainProviders } from "sdk/localsdk/multichain/configs/chainProviders"

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Configuration options for the SolanaDomainResolver
 */
export interface ResolverConfig {
  /** Solana RPC endpoint URL. Defaults to mainnet-beta if not provided */
  rpcUrl?: string;
  /** Commitment level for transactions. Defaults to 'confirmed' */
  commitment?: Commitment;
}

/**
 * Result of a single record resolution
 */
export interface RecordResult {
  /** The record key that was queried */
  key: string;
  /** The resolved value, or null if not found */
  value: string | null;
  /** Whether the record was successfully found */
  found: boolean;
  /** Error message if resolution failed */
  error?: string;
}

/**
 * Complete domain resolution result
 */
export interface DomainResolutionResult {
  /** The full domain name (label.tld) */
  domain: string;
  /** Whether the domain exists on-chain */
  exists: boolean;
  /** The derived SLD PDA address */
  sldPda: string;
  /** Domain properties PDA address */
  domainPropertiesPda?: string;
  /** Records version from domain properties */
  recordsVersion?: number;
  /** Array of record resolution results */
  records: RecordResult[];
  /** The owner of the domain */
  owner?: string;
  /** Any error that occurred during resolution */
  error?: string;
}

/**
 * Error thrown when a domain is not found on-chain
 * @class
 * @extends Error
 */
export class DomainNotFoundError extends Error {
  /**
   * Creates a new DomainNotFoundError
   * @param {string} domain - The domain that was not found
   */
  constructor(domain: string) {
    super(`Domain not found: ${domain}`)
    this.name = "DomainNotFoundError"
  }
}

/**
 * Error thrown when a specific record is not found for a domain
 * @class
 * @extends Error
 */
export class RecordNotFoundError extends Error {
  /**
   * Creates a new RecordNotFoundError
   * @param {string} recordKey - The record key that was not found
   */
  constructor(recordKey: string) {
    super(`Record not found: ${recordKey}`)
    this.name = "RecordNotFoundError"
  }
}

/**
 * Error thrown when connection to Solana RPC fails
 * @class
 * @extends Error
 */
export class ConnectionError extends Error {
  /**
   * Creates a new ConnectionError
   * @param {string} message - The error message describing the connection failure
   */
  constructor(message: string) {
    super(`Connection error: ${message}`)
    this.name = "ConnectionError"
  }
}

// ============================================================================
// Solana Domain Resolver Class
// ============================================================================

/**
 * SolanaDomainResolver - A portable class for resolving Unstoppable Domains on Solana blockchain
 *
 * This class provides a clean, type-safe API for interacting with the Unstoppable Domains
 * Solana program. It handles PDA derivation, record resolution, and error handling,
 * returning structured JSON responses suitable for integration into any application.
 *
 * @class
 * @example Basic usage
 * ```typescript
 * const resolver = new SolanaDomainResolver({
 *   rpcUrl: "https://api.mainnet-beta.solana.com"
 * });
 *
 * const result = await resolver.resolve("partner-engineering", "demos", [
 *   "crypto.ETH.address",
 *   "crypto.SOL.address"
 * ]);
 *
 * console.log(result);
 * ```
 *
 * @example Using environment variables
 * ```typescript
 * // Automatically uses SOLANA_RPC from environment
 * const resolver = new SolanaDomainResolver();
 *
 * const ethAddress = await resolver.resolveRecord(
 *   "myname",
 *   "crypto",
 *   "crypto.ETH.address"
 * );
 * ```
 */
export class SolanaDomainResolver {
  /** @private Resolver configuration with RPC URL and commitment level */
  private readonly config: Required<ResolverConfig>

  /** @private Unstoppable Domains program ID */
  private readonly unsProgramId: PublicKey

  /** @private Default version buffer for PDA derivation */
  private readonly defaultVersion: Buffer

  /** @private Cached Anchor program instance */
  private program: Program<UnsSol> | null = null

  /**
   * Creates a new SolanaDomainResolver instance
   *
   * @param {ResolverConfig} [config={}] - Configuration options
   * @param {string} [config.rpcUrl] - Solana RPC endpoint URL. Defaults to SOLANA_RPC env var or public mainnet
   * @param {Commitment} [config.commitment='confirmed'] - Transaction commitment level
   *
   * @example
   * ```typescript
   * // With custom RPC
   * const resolver = new SolanaDomainResolver({
   *   rpcUrl: "https://my-custom-rpc.com",
   *   commitment: "finalized"
   * });
   *
   * // With defaults
   * const resolver = new SolanaDomainResolver();
   * ```
   */
  constructor(config: ResolverConfig = {}) {
    this.config = {
      rpcUrl: config.rpcUrl || process.env.SOLANA_RPC || chainProviders.solana.mainnet,
      commitment: config.commitment || "confirmed",
    }
    this.unsProgramId = new PublicKey(UnsSolIdl.address)
    this.defaultVersion = Buffer.from([1])
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  /**
   * Hash a seed string using SHA-256 for PDA derivation
   *
   * @private
   * @param {string} seed - The seed string to hash
   * @returns {Uint8Array} The SHA-256 hash as a Uint8Array
   */
  private hashSeedStr(seed: string): Uint8Array {
    const hash = createHash("sha256").update(Buffer.from(seed)).digest()
    return Uint8Array.from(hash)
  }

  /**
   * Derive the Second-Level Domain (SLD) Program Derived Address (PDA)
   *
   * The SLD PDA is deterministically derived from the domain label, TLD, and program ID.
   * This address uniquely identifies a domain on-chain.
   *
   * @private
   * @param {string} label - The domain label (e.g., "partner-engineering")
   * @param {string} tld - The top-level domain (e.g., "demos")
   * @param {Buffer} [version=this.defaultVersion] - Version buffer for PDA derivation
   * @returns {PublicKey} The derived SLD PDA
   */
  private deriveSldPda(label: string, tld: string, version = this.defaultVersion): PublicKey {
    const [result] = PublicKey.findProgramAddressSync(
      [version, Buffer.from("sld"), this.hashSeedStr(tld), this.hashSeedStr(label)],
      this.unsProgramId,
    )
    return result
  }

  /**
   * Derive the Domain Properties Program Derived Address (PDA)
   *
   * The properties PDA stores metadata about the domain including the records version number.
   * This must be fetched before resolving records.
   *
   * @private
   * @param {PublicKey} sldPda - The SLD PDA for the domain
   * @param {Buffer} [version=this.defaultVersion] - Version buffer for PDA derivation
   * @returns {PublicKey} The derived domain properties PDA
   */
  private deriveDomainPropertiesPda(sldPda: PublicKey, version = this.defaultVersion): PublicKey {
    const [domainPropertiesPda] = PublicKey.findProgramAddressSync(
      [version, Buffer.from("domain_properties"), sldPda.toBuffer()],
      this.unsProgramId,
    )
    return domainPropertiesPda
  }

  /**
   * Derive a Record Program Derived Address (PDA)
   *
   * Each record (e.g., crypto address) is stored at a unique PDA derived from the
   * domain SLD PDA, record key, and records version number.
   *
   * @private
   * @param {number} recordVersion - The records version from domain properties
   * @param {PublicKey} sldPda - The SLD PDA for the domain
   * @param {string} recordKey - The record key (e.g., "crypto.ETH.address")
   * @param {Buffer} [version=this.defaultVersion] - Version buffer for PDA derivation
   * @returns {PublicKey} The derived record PDA
   */
  private deriveRecordPda(
    recordVersion: number,
    sldPda: PublicKey,
    recordKey: string,
    version = this.defaultVersion,
  ): PublicKey {
    const bigIntRecordVersion = BigInt(recordVersion)

    // Validate recordVersion before BigInt conversion to prevent TypeError
    if (bigIntRecordVersion < BigInt(0)) {
      throw new Error(
        `Invalid record version: ${bigIntRecordVersion}. Must be a non-negative integer.`,
      )
    }

    const versionBuffer = Buffer.alloc(8)
    versionBuffer.writeBigUInt64LE(bigIntRecordVersion)

    const [userRecordPda] = PublicKey.findProgramAddressSync(
      [
        version,
        Buffer.from("record"),
        versionBuffer,
        sldPda.toBuffer(),
        this.hashSeedStr(recordKey),
      ],
      this.unsProgramId,
    )
    return userRecordPda
  }

  /**
   * Initialize or get the cached Anchor program instance
   *
   * This method creates a connection to the Solana RPC and initializes the
   * Anchor program for the Unstoppable Domains contract. The program instance
   * is cached for subsequent calls to improve performance.
   *
   * @private
   * @async
   * @returns {Promise<Program<UnsSol>>} The Anchor program instance
   * @throws {ConnectionError} If connection to Solana RPC fails
   */
  private async getProgram(): Promise<Program<UnsSol>> {
    if (this.program) {
      return this.program
    }

    try {
      const connection = new Connection(this.config.rpcUrl, this.config.commitment)
      // Create a dummy wallet since we're only reading data
      const dummyKeypair = Keypair.generate()
      const wallet = new Wallet(dummyKeypair)
      const provider = new AnchorProvider(connection, wallet, {
        commitment: this.config.commitment,
      })
      this.program = new Program(UnsSolIdl as any,provider) as Program<UnsSol>
      return this.program
    } catch (error) {
      throw new ConnectionError(
        error instanceof Error ? error.message : "Failed to connect to Solana RPC",
      )
    }
  }

  /**
   * Get the owner (token holder) of a Solana domain
   *
   * Solana UD domains are SPL Token-2022 NFTs where:
   * - The SLD PDA serves as the mint address
   * - The owner is whoever holds the token in their wallet
   *
   * This method uses getTokenLargestAccounts() which is optimized for NFTs (supply=1)
   * and returns the holder's address by parsing the token account data.
   *
   * @private
   * @async
   * @param {PublicKey} sldPda - The SLD PDA (which is the mint address)
   * @returns {Promise<string | undefined>} The owner's Solana address, or undefined if not found
   */
  private async getTokenOwner(sldPda: PublicKey): Promise<string | undefined> {
    try {
      const program = await this.getProgram()
      const connection = program.provider.connection

      // Get the largest token account holders for this mint (NFT should have only 1)
      const tokenAccounts = await connection.getTokenLargestAccounts(sldPda)

      if (tokenAccounts.value.length === 0) {
        log.debug(`No token accounts found for mint ${sldPda.toString()}`)
        return undefined
      }

      // Get parsed account info to extract owner
      const tokenAccountInfo = await connection.getParsedAccountInfo(
        tokenAccounts.value[0].address,
      )

      // Try to extract owner from parsed data
      if (
        tokenAccountInfo.value &&
        "parsed" in tokenAccountInfo.value.data &&
        tokenAccountInfo.value.data.parsed.info &&
        tokenAccountInfo.value.data.parsed.info.owner
      ) {
        const owner = tokenAccountInfo.value.data.parsed.info.owner
        log.debug(`Found domain owner via parsed data: ${owner}`)
        return owner
      }

      // Fallback: parse raw token account data
      if (tokenAccountInfo.value && "data" in tokenAccountInfo.value.data) {
        const accountInfo = await connection.getAccountInfo(tokenAccounts.value[0].address)

        if (accountInfo && accountInfo.data.length >= 64) {
          // SPL Token account layout: mint (32 bytes) + owner (32 bytes) + ...
          const ownerBytes = accountInfo.data.slice(32, 64)
          const owner = new PublicKey(ownerBytes).toString()
          log.debug(`Found domain owner via raw data: ${owner}`)
          return owner
        }
      }

      log.debug(`Could not extract owner from token account ${tokenAccounts.value[0].address.toString()}`)
      return undefined
    } catch (error) {
      log.debug(
        `Failed to fetch owner for domain with mint ${sldPda.toString()}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return undefined
    }
  }

  // ==========================================================================
  // Public API Methods
  // ==========================================================================

  /**
   * Resolve a single record for a domain
   *
   * This method fetches a specific record (like a cryptocurrency address) for a given domain.
   * It handles all PDA derivation and error cases, returning a structured result.
   *
   * @public
   * @async
   * @param {string} label - The domain label (e.g., "partner-engineering")
   * @param {string} tld - The top-level domain (e.g., "demos")
   * @param {string} recordKey - The record key to resolve (e.g., "crypto.ETH.address")
   * @returns {Promise<RecordResult>} RecordResult with the resolved value or error details
   *
   * @example
   * ```typescript
   * const result = await resolver.resolveRecord(
   *   "myname",
   *   "crypto",
   *   "crypto.ETH.address"
   * );
   *
   * if (result.found) {
   *   console.log(`ETH Address: ${result.value}`);
   * } else {
   *   console.log(`Error: ${result.error}`);
   * }
   * ```
   */
  async resolveRecord(label: string, tld: string, recordKey: string): Promise<RecordResult> {
    // Validate domain components early to avoid unnecessary async operations
    const trimmedLabel = label?.trim()
    const trimmedTld = tld?.trim()

    if (!trimmedLabel || !trimmedTld) {
      return {
        key: recordKey,
        value: null,
        found: false,
        error: "Invalid domain: label and tld must be non-empty strings",
      }
    }

    try {
      const program = await this.getProgram()
      const sldPda = this.deriveSldPda(trimmedLabel, trimmedTld)
      const domainPropertiesPda = this.deriveDomainPropertiesPda(sldPda)

      // Get domain properties to get records_version
      let domainProperties
      try {
        domainProperties = await program.account.domainProperties.fetch(domainPropertiesPda)
      } catch (error) {
        return {
          key: recordKey,
          value: null,
          found: false,
          error: `Domain ${trimmedLabel}.${trimmedTld} not found`,
        }
      }

      // Fetch the specific record
      const recordPda = this.deriveRecordPda(domainProperties.recordsVersion, sldPda, recordKey)

      try {
        const record = await program.account.record.fetch(recordPda)
        return {
          key: recordKey,
          value: record.value,
          found: true,
        }
      } catch (error) {
        return {
          key: recordKey,
          value: null,
          found: false,
          error: "Record not found",
        }
      }
    } catch (error) {
      return {
        key: recordKey,
        value: null,
        found: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      }
    }
  }

  /**
   * Resolve multiple records for a domain in parallel
   *
   * This is the most efficient method for fetching multiple records for a domain.
   * All records are resolved in parallel for better performance. The result includes
   * domain metadata, PDAs, and an array of all record results.
   *
   * @public
   * @async
   * @param {string} label - The domain label (e.g., "partner-engineering")
   * @param {string} tld - The top-level domain (e.g., "demos")
   * @param {string[]} recordKeys - Array of record keys to resolve
   * @returns {Promise<DomainResolutionResult>} Complete resolution result with all records
   *
   * @example
   * ```typescript
   * const result = await resolver.resolve("myname", "crypto", [
   *   "crypto.ETH.address",
   *   "crypto.SOL.address",
   *   "crypto.BTC.address"
   * ]);
   *
   * if (result.exists) {
   *   result.records.forEach(record => {
   *     if (record.found) {
   *       console.log(`${record.key}: ${record.value}`);
   *     }
   *   });
   * }
   * ```
   */
  async resolve(label: string, tld: string, recordKeys: string[]): Promise<DomainResolutionResult> {
    // Validate domain components early
    const trimmedLabel = label?.trim()
    const trimmedTld = tld?.trim()

    if (!trimmedLabel || !trimmedTld) {
      // Return consistent error structure without attempting PDA derivation
      return {
        domain: `${label ?? ""}.${tld ?? ""}`,
        exists: false,
        sldPda: "",
        records: [],
        error: "Invalid domain: label and tld must be non-empty strings",
      }
    }

    const domain = `${trimmedLabel}.${trimmedTld}`

    // Validate recordKeys is an array
    if (!Array.isArray(recordKeys)) {
      const sldPda = this.deriveSldPda(trimmedLabel, trimmedTld)
      return {
        domain,
        exists: false,
        sldPda: sldPda.toString(),
        records: [],
        error: "Invalid recordKeys: must be an array of strings",
      }
    }

    // Filter out invalid record keys (empty strings or non-strings)
    const validRecordKeys = recordKeys.filter(
      (key) => typeof key === "string" && key.trim() !== "",
    )

    // try {
      const program = await this.getProgram()
      const sldPda = this.deriveSldPda(trimmedLabel, trimmedTld)
      const domainPropertiesPda = this.deriveDomainPropertiesPda(sldPda)

      // Try to fetch domain properties
      let domainProperties
      try {
        domainProperties = await program.account.domainProperties.fetch(domainPropertiesPda)
        log.debug("domainProperties: " + JSON.stringify(domainProperties))

      } catch (error) {
        log.error("domainProperties fetch error: " + error)
        return {
          domain,
          exists: false,
          sldPda: sldPda.toString(),
          records: [],
          error: `Domain ${domain} not found on-chain`,
        }
      }

      // Fetch all records and owner in parallel for better performance
      const recordsPromise = Promise.all(
        validRecordKeys.map(async (recordKey) => {
          try {
            const recordPda = this.deriveRecordPda(
              domainProperties.recordsVersion,
              sldPda,
              recordKey,
            )
            const record = await program.account.record.fetch(recordPda)
            return {
              key: recordKey,
              value: record.value,
              found: true,
            }
          } catch (error) {
            return {
              key: recordKey,
              value: null,
              found: false,
              error: "Record not found",
            }
          }
        }),
      )

      // Fetch owner and records concurrently
      const [records, owner] = await Promise.all([
        recordsPromise,
        this.getTokenOwner(sldPda),
      ])

      return {
        domain,
        exists: true,
        sldPda: sldPda.toString(),
        domainPropertiesPda: domainPropertiesPda.toString(),
        recordsVersion: Number(domainProperties.recordsVersion),
        owner,
        records,
      }
    // } catch (error) {
    //   return {
    //     domain,
    //     exists: false,
    //     sldPda: this.deriveSldPda(trimmedLabel, trimmedTld).toString(),
    //     records: [],
    //     error: error instanceof Error ? error.message : "Unknown error occurred",
    //   }
    // }
  }

  /**
   * Resolve a full domain name using "label.tld" format
   *
   * Convenience method that accepts a full domain string instead of separate label and TLD.
   * Internally validates the format and delegates to the resolve() method.
   *
   * @public
   * @async
   * @param {string} fullDomain - Full domain in format "label.tld" (e.g., "partner-engineering.demos")
   * @param {string[]} recordKeys - Array of record keys to resolve
   * @returns {Promise<DomainResolutionResult>} Complete resolution result with all records
   *
   * @example
   * ```typescript
   * const result = await resolver.resolveDomain("myname.crypto", [
   *   "crypto.ETH.address",
   *   "crypto.SOL.address"
   * ]);
   *
   * console.log(JSON.stringify(result, null, 2));
   * ```
   */
  async resolveDomain(fullDomain: string, recordKeys: string[]): Promise<DomainResolutionResult> {
    const parts = fullDomain.split(".")
    if (parts.length !== 2) {
      return {
        domain: fullDomain,
        exists: false,
        sldPda: "",
        records: [],
        error: "Invalid domain format. Expected format: label.tld",
      }
    }

    const [label, tld] = parts
    if (!label || !tld) {
      return {
        domain: fullDomain,
        exists: false,
        sldPda: "",
        records: [],
        error: "Invalid domain format. Label and TLD cannot be empty",
      }
    }

    return this.resolve(label, tld, recordKeys)
  }

  /**
   * Check if a domain exists on-chain without fetching records
   *
   * This is a lightweight method for checking domain existence. It only attempts to
   * fetch the domain properties account and returns a boolean result.
   *
   * @public
   * @async
   * @param {string} label - The domain label (e.g., "partner-engineering")
   * @param {string} tld - The top-level domain (e.g., "demos")
   * @returns {Promise<boolean>} True if domain exists, false otherwise
   *
   * @example
   * ```typescript
   * const exists = await resolver.domainExists("myname", "crypto");
   * if (exists) {
   *   console.log("Domain is registered");
   * } else {
   *   console.log("Domain is available");
   * }
   * ```
   */
  async domainExists(label: string, tld: string): Promise<boolean> {
    try {
      const program = await this.getProgram()
      const sldPda = this.deriveSldPda(label, tld)
      const domainPropertiesPda = this.deriveDomainPropertiesPda(sldPda)

      await program.account.domainProperties.fetch(domainPropertiesPda)
      return true
    } catch (error) {
      return false
    }
  }

  /**
   * Get domain metadata and PDAs without resolving records
   *
   * This method retrieves domain information including the SLD PDA, properties PDA,
   * and records version without fetching any actual records. Useful for inspecting
   * domain metadata or preparing for record resolution.
   *
   * @public
   * @async
   * @param {string} label - The domain label (e.g., "partner-engineering")
   * @param {string} tld - The top-level domain (e.g., "demos")
   * @returns {Promise<Omit<DomainResolutionResult, "records">>} Domain information without records
   *
   * @example
   * ```typescript
   * const info = await resolver.getDomainInfo("myname", "crypto");
   * console.log(`SLD PDA: ${info.sldPda}`);
   * console.log(`Records Version: ${info.recordsVersion}`);
   * ```
   */
  async getDomainInfo(label: string, tld: string): Promise<Omit<DomainResolutionResult, "records">> {
    const domain = `${label}.${tld}`

    try {
      const program = await this.getProgram()
      const sldPda = this.deriveSldPda(label, tld)
      const domainPropertiesPda = this.deriveDomainPropertiesPda(sldPda)

      try {
        const domainProperties = await program.account.domainProperties.fetch(domainPropertiesPda)
        return {
          domain,
          exists: true,
          sldPda: sldPda.toString(),
          domainPropertiesPda: domainPropertiesPda.toString(),
          recordsVersion: Number(domainProperties.recordsVersion),
        }
      } catch (error) {
        return {
          domain,
          exists: false,
          sldPda: sldPda.toString(),
          error: `Domain ${domain} not found on-chain`,
        }
      }
    } catch (error) {
      return {
        domain,
        exists: false,
        sldPda: "",
        error: error instanceof Error ? error.message : "Unknown error occurred",
      }
    }
  }
}

