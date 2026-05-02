DEM → OS Denomination Migration Plan

Overview

Goal:
Introduce OS (smallest unit) as the internal denomination for the Demos SDK. All amounts stored, transmitted (wire), and processed internally will use OS (BigInt). Human‑facing APIs will provide DEM convenience methods.

Conversion: 1 DEM = 1 000 000 000 OS (9 decimals)

Strategy:
Breaking change – major version bump. No backwards compatibility shims.

Internal representation:
BigInt for all calculations. string on the wire (JSON serialization).

⚠️ AGENT NOTE: Before modifying any file referenced below, check ../sdks for the original TypeScript source file counterpart. The paths below reference compiled documentation at /app/docs-repo. The actual source files live in ../sdks under the same module structure (e.g., src/types/blockchain/Transaction.ts). Always modify the source, not the compiled output.

Phase 0: Foundation – Constants & Conversion Utilities

0.1 Create src/denomination/constants.ts

/**
 * DEM/OS denomination constants.
 * 1 DEM = 10⁹ OS (1 000 000 000 OS)
 */
export const OS_DECIMALS = 9;
export const OS_PER_DEM = BigInt(10 ** OS_DECIMALS); // 1_000_000_000n

/** Minimum transferable amount: 1 OS */
export const MIN_AMOUNT_OS = 1n;

/** Zero amount constant */
export const ZERO_OS = 0n;


0.2 Create src/denomination/conversion.ts

import { OS_PER_DEM, OS_DECIMALS, ZERO_OS } from "./constants";

/**
 * Convert DEM (human‑readable) to OS (smallest unit).
 * Accepts number or string for convenience. Returns BigInt.
 *
 * @example demToOs(1) => 1_000_000_000n
 * @example demToOs("0.5") => 500_000_000n
 * @example demToOs(100) => 100_000_000_000n
 */
export function demToOs(dem: number | string): bigint {
  const str = typeof dem === "number" ? dem.toString() : dem;

  // Split on decimal point
  const [whole, frac = ""] = str.split(".");

  if (frac.length > OS_DECIMALS) {
    throw new Error(
      `DEM amount "${str}" exceeds maximum ${OS_DECIMALS} decimal places`
    );
  }

  const paddedFrac = frac.padEnd(OS_DECIMALS, "0");
  const combined = `${whole}${paddedFrac}`;

  const result = BigInt(combined);
  if (result < ZERO_OS) {
    throw new Error(`Negative amounts not allowed: ${str}`);
  }
  return result;
}

/**
 * Convert OS (smallest unit) to DEM (human‑readable string).
 * Always returns a string to preserve precision.
 *
 * @example osToDem(1_000_000_000n) => "1.0"
 * @example osToDem(500_000_000n) => "0.5"
 * @example osToDem(1n) => "0.000000001"
 */
export function osToDem(os: bigint): string {
  const isNegative = os < ZERO_OS;
  const abs = isNegative ? -os : os;
  const str = abs.toString().padStart(OS_DECIMALS + 1, "0");

  const whole = str.slice(0, str.length - OS_DECIMALS);
  const frac = str.slice(str.length - OS_DECIMALS);

  // Trim trailing zeros but keep at least one decimal
  const trimmedFrac = frac.replace(/0+$/, "") || "0";

  return `${isNegative ? "-" : ""}${whole}.${trimmedFrac}`;
}

/**
 * Parse a wire‑format OS string to BigInt.
 * Wire format is always OS as a decimal string.
 *
 * @example parseOsString("1000000000") => 1_000_000_000n
 */
export function parseOsString(osString: string): bigint {
  return BigInt(osString);
}

/**
 * Serialize a BigInt OS amount to wire‑format string.
 *
 * @example toOsString(1_000_000_000n) => "1000000000"
 */
export function toOsString(os: bigint): string {
  return os.toString();
}

/**
 * Format OS amount as human‑readable DEM string with unit.
 *
 * @example formatDem(1_000_000_000n) => "1.0 DEM"
 */
export function formatDem(os: bigint): string {
  return `${osToDem(os)} DEM`;
}


0.3 Create src/denomination/index.ts

export {
  OS_DECIMALS,
  OS_PER_DEM,
  MIN_AMOUNT_OS,
  ZERO_OS,
} from "./constants";

export {
  demToOs,
  osToDem,
  parseOsString,
  toOsString,
  formatDem,
} from "./conversion";


0.4 Export from main SDK entry point

Find the SDK's main index.ts (likely src/index.ts or src/websdk/index.ts) and add:

export * from "./denomination";


0.5 Create src/denomination/conversion.test.ts

import { describe, it, expect } from "bun:test";
import {
  demToOs,
  osToDem,
  parseOsString,
  toOsString,
  formatDem,
} from "./conversion";

describe("demToOs", () => {
  it("converts whole DEM to OS", () => {
    expect(demToOs(1)).toBe(1_000_000_000n);
    expect(demToOs(100)).toBe(100_000_000_000n);
    expect(demToOs(0)).toBe(0n);
  });

  it("converts fractional DEM to OS", () => {
    expect(demToOs("0.5")).toBe(500_000_000n);
    expect(demToOs("0.000000001")).toBe(1n);
    expect(demToOs("1.123456789")).toBe(1_123_456_789n);
  });

  it("rejects too many decimals", () => {
    expect(() => demToOs("0.0000000001")).toThrow(
      "exceeds maximum 9 decimal places"
    );
  });

  it("accepts string input", () => {
    expect(demToOs("100")).toBe(100_000_000_000n);
  });
});

describe("osToDem", () => {
  it("converts OS to DEM string", () => {
    expect(osToDem(1_000_000_000n)).toBe("1.0");
    expect(osToDem(500_000_000n)).toBe("0.5");
    expect(osToDem(1n)).toBe("0.000000001");
    expect(osToDem(0n)).toBe("0.0");
  });

  it("handles large amounts", () => {
    expect(osToDem(1_000_000_000_000_000_000n)).toBe("1000000000.0");
  });
});

describe("wire format", () => {
  it("round‑trips through string serialization", () => {
    const original = 123_456_789_012n;
    const wire = toOsString(original);
    expect(parseOsString(wire)).toBe(original);
  });
});

describe("formatDem", () => {
  it("formats with unit", () => {
    expect(formatDem(1_000_000_000n)).toBe("1.0 DEM");
  });
});


Phase 1: Type Definitions – Migrate All Interfaces to OS (BigInt/string)

1.1 Update src/types/blockchain/TxFee.ts

/**
 * Transaction fee structure. All amounts in OS (smallest unit).
 * Serialized as strings on the wire.
 */
export interface TxFee {
  network_fee: string;   // OS amount as string (wire format)
  rpc_fee: string;       // OS amount as string (wire format)
  additional_fee: string; // OS amount as string (wire format)
}


1.2 Update src/types/blockchain/Transaction.ts

export interface TransactionContent {
  // ... other fields
  amount: string;           // OS amount as string (wire format)
  transaction_fee: TxFee;   // Already migrated
  custom_charges?: CustomCharges;
}


1.3 Update src/types/blockchain/rawTransaction.ts

export interface RawTransaction {
  amount: string;           // OS amount as string
  networkFee: string;       // OS amount as string
  rpcFee: string;           // OS amount as string
  additionalFee: string;    // OS amount as string
  // ... other fields
}


1.4 Update src/types/blockchain/statusNative.ts

export interface StatusNative {
  address: string;
  balance: string;   // OS amount as string
  nonce: number;
  tx_list: string;
}


1.5 Update src/types/gls/account.ts

/**
 * Account balance in OS (smallest unit). Previously stored as DEM.
 */
export interface Account {
  balance: string;  // OS amount as string (was DEM, now OS)
  // ... other fields
}


1.6 Update src/types/gls/StateChange.ts

export interface StateChange {
  nativeAmount: string;   // OS amount as string
  sender: BinaryBuffer;
  receiver: BinaryBuffer;
  // ... other fields
}


1.7 Update src/types/blockchain/CustomCharges.ts

export interface IPFSCustomCharges {
  max_cost_os: string;    // RENAMED: OS amount as string (9 decimals, not 18)
  file_size_bytes: number;
  operation: "IPFS_ADD" | "IPFS_PIN" | "IPFS_UNPIN";
  duration_blocks?: number;
  estimated_breakdown?: any;
}


1.8 Update src/bridge/nativeBridgeTypes.ts

export type NativeBridgeOperation = {
  amount: string;       // OS amount as string
  // ...
};

export type EVMTankData = {
  amountExpected: string;  // OS amount as string (was number)
  // ...
};


1.9 Update src/types/blockchain/TransactionSubtypes/NativeTransaction.ts

Ensure all amount fields in NativeTransactionContent are strings (OS).

Phase 2: Storage & TLSNotary Constants – Migrate to OS

2.1 Update Storage Program Constants

import { OS_PER_DEM } from "../denomination";

export const STORAGE_PROGRAM_CONSTANTS = {
  FEE_PER_CHUNK: OS_PER_DEM,   // 1 DEM (in OS) per chunk = 1_000_000_000n OS
  PRICING_CHUNK_BYTES: 10240,
  MAX_SIZE_BYTES: 1048576,
  MAX_JSON_NESTING_DEPTH: 64,
};


2.2 Update src/tlsnotary/helpers.ts – calculateStorageFee

import { OS_PER_DEM } from "../denomination";

/**
 * Calculate storage fee for TLSNotary proof.
 * @param proofSizeKB - Proof size in kilobytes
 * @returns Fee in OS (BigInt)
 */
export function calculateStorageFee(proofSizeKB: number): bigint {
  const baseFee = OS_PER_DEM;       // 1 DEM in OS
  const perKBFee = OS_PER_DEM;      // 1 DEM per KB in OS
  return baseFee + BigInt(Math.ceil(proofSizeKB)) * perKBFee;
}


2.3 Update Storage Program fee calculation

import { OS_PER_DEM } from "../denomination";

const fee = BigInt(chunks) * OS_PER_DEM; // OS


Phase 3: IPFS Module – Migrate Custom Charges

3.1 Update src/ipfs/IPFSOperations.ts

import { demToOs, toOsString } from "../denomination";

static quoteToCustomCharges(quote: any): {
  estimatedBreakdown: any;
  maxCostOs: string; // RENAMED
} {
  const maxCostOs = toOsString(demToOs(quote.cost));
  return {
    estimatedBreakdown: quote.breakdown,
    maxCostOs,
  };
}


3.2 Update createCustomCharges method

static createCustomCharges(
  quote: any,
  operation: "IPFS_ADD" | "IPFS_PIN" | "IPFS_UNPIN",
  durationBlocks?: number
): IPFSCustomCharges {
  const { maxCostOs, estimatedBreakdown } = this.quoteToCustomCharges(quote);
  return {
    max_cost_os: maxCostOs,
    file_size_bytes: this.getContentSize(quote.content),
    operation,
    duration_blocks: durationBlocks,
    estimated_breakdown: estimatedBreakdown,
  };
}


3.3 Update all IPFS payload builders

Search for any reference to max_cost_dem in src/ipfs/ and rename it to max_cost_os. Ensure all cost values go through demToOs() or are already in OS.

Phase 4: Wallet – Migrate Balance & Transfer

4.1 Update src/wallet/Wallet.ts

import { parseOsString, osToDem } from "../denomination";

async getBalance(): Promise<void> {
  const response = await this.demos.getAddressInfo(this.getAddress());
  this._balance = parseOsString(response.balance); // BigInt internally
}

/**
 * Get balance in OS (BigInt).
 */
get balanceOs(): bigint {
  return this._balance;
}

/**
 * Get balance as human‑readable DEM string.
 */
get balanceDem(): string {
  return osToDem(this._balance);
}


4.2 Update transfer method

import { toOsString } from "../denomination";

/**
 * Transfer DEM tokens.
 * @param to - Recipient address
 * @param amountOs - Amount in OS (BigInt)
 * @param demos - Demos instance
 */
async transfer(
  to: string,
  amountOs: bigint,
  demos: Demos
): Promise<RPCResponseWithValidityData> {
  const tx: TransactionContent = {
    amount: toOsString(amountOs),
    // ... rest of transaction building
  };
  // ...
}


4.3 Add private _balance field

private _balance: bigint = 0n;


Phase 5: Main Demos Class – Migrate Public API

5.1 Update src/websdk/Demos.ts (or wherever the main Demos class lives)

import { demToOs } from "../denomination";

/**
 * Transfer tokens.
 * @param to - Recipient address
 * @param amountOs - Amount in OS (BigInt). Use demToOs() to convert from DEM.
 *
 * @example
 * // Send 100 DEM
 * await demos.transfer("0x...", demToOs(100));
 *
 * // Send 1.5 DEM
 * await demos.transfer("0x...", demToOs("1.5"));
 *
 * // Send exact OS amount
 * await demos.transfer("0x...", 1_500_000_000n);
 */
async transfer(to: string, amountOs: bigint): Promise<Transaction> {
  return this.wallet.transfer(to, amountOs, this);
}


5.2 Update getAddressInfo return type

async getAddressInfo(address: string): Promise<StatusNative> {
  const raw = await this.rpcCall("getAddressInfo", { address });
  return {
    ...raw,
    balance:
      typeof raw.balance === "number"
        ? toOsString(demToOs(raw.balance))
        : raw.balance, // already OS string from updated node
  };
}


Once the node is fully migrated, remove the typeof fallback.

Phase 6: Escrow Module – Migrate Amounts

6.1 Update src/escrow/EscrowTransaction.ts

/**
 * Send DEM to an unclaimed social identity via escrow.
 * @param amountOs - Amount in OS (BigInt). Use demToOs() to convert from DEM.
 */
static async sendToIdentity(
  demos: Demos,
  platform: string,
  username: string,
  amountOs: bigint,
  options?: { expiryDays?: number; message?: string }
): Promise<Transaction> {
  // Build with toOsString(amountOs) for wire format
  // ...
}


6.2 Update EscrowBalance and related interfaces

Any amount or balance field in escrow types should become string (OS on wire).

Phase 7: Bridge Module – Migrate Amounts

7.1 Update src/bridge/nativeBridge.ts

// depositAmount is now OS string – callers must pass toOsString(amountOs)


7.2 Update EVMTankData.amountExpected

amountExpected: toOsString(demToOs(someNumberInDem))


Phase 8: Internal Transaction Building – Migrate All Serialization

8.1 Audit all transaction construction paths

Search the entire src/ for any place that constructs a TransactionContent, RawTransaction, or any object with an amount field. Every one must now use string (OS).

8.2 Update src/utils/dataManipulation.ts if needed

// If ObjectToHex / HexToObject handle amount serialization,
// ensure BigInt values survive the round‑trip.
// JSON.stringify does not handle BigInt natively – amounts must be strings before serialization.


8.3 RPC layer

Find where RPC requests are built (likely in the Demos class or a dedicated RPC module). Ensure:

Outgoing amounts are toOsString(bigintValue)

Incoming amounts are parsed with parseOsString(stringValue)

Phase 9: Tests – Update All Test Files

9.1 Update existing tests

Search for all test files (`.test.ts, .spec.ts`) and update:

Any amount: 100 → amount: toOsString(demToOs(100))

Any balance assertions to use OS values

Any fee assertions to use OS values

9.2 Add denomination conversion tests

Already created in Phase 0.5.

9.3 Add integration‑style tests

import { describe, it, expect } from "bun:test";
import {
  demToOs,
  osToDem,
  toOsString,
  parseOsString,
} from "../denomination";

describe("end‑to‑end amount flow", () => {
  it("user input → wire → display round‑trip", () => {
    const userInput = "1.5";
    const osAmount = demToOs(userInput);              // 1_500_000_000n
    const wireFormat = toOsString(osAmount);           // "1500000000"
    const parsed = parseOsString(wireFormat);          // 1_500_000_000n
    const display = osToDem(parsed);                   // "1.5"

    expect(osAmount).toBe(1_500_000_000n);
    expect(wireFormat).toBe("1500000000");
    expect(parsed).toBe(osAmount);
    expect(display).toBe("1.5");
  });

  it("storage fee calculation in OS", () => {
    const chunks = Math.ceil(15 * 1024 / 10240); // 2 chunks
    const fee = BigInt(chunks) * demToOs(1);
    expect(fee).toBe(2_000_000_000n);
  });
});


Phase 10: Package Version & Documentation

10.1 Bump major version in package.json

{
  "name": "@kynesyslabs/demosdk",
  "version": "X.0.0"
}


Where X is current major + 1.

10.2 Update any inline documentation / JSDoc

/**
 * @param amountOs - Amount in OS (smallest unit). Use demToOs() to convert from DEM.
 */


10.3 Update SDK usage examples

import { demToOs } from "@kynesyslabs/demosdk";

const tx = await demos.transfer("0x...", demToOs(100));


Phase Summary & Dependency Order

Phase 0: Foundation (constants, conversion, tests)          — no dependencies
Phase 1: Type definitions (all interfaces)                 — depends on Phase 0
Phase 2: Storage & TLSNotary constants                    — depends on Phase 0
Phase 3: IPFS module                                      — depends on Phase 0, 1
Phase 4: Wallet                                            — depends on Phase 0, 1
Phase 5: Main Demos class                                 — depends on Phase 0, 1, 4
Phase 6: Escrow module                                     — depends on Phase 0, 1, 5
Phase 7: Bridge module                                     — depends on Phase 0, 1
Phase 8: Internal serialization audit                     — depends on all above
Phase 9: Tests                                             — depends on all above
Phase 10: Version bump & docs                            — final


Checklist for the Agent

Phase 0 – Create src/denomination with constants, conversion, index, tests

Phase 1 – Migrate all type interfaces to OS string amounts

Phase 2 – Update STORAGE_PROGRAM_CONSTANTS and calculateStorageFee

Phase 3 – Rename max_cost_dem → max_cost_os, fix IPFS charge calculations

Phase 4 – Wallet balance as BigInt, transfer accepts BigInt

Phase 5 – Demos.transfer accepts BigInt, getAddressInfo returns OS

Phase 6 – Escrow amounts to BigInt

Phase 7 – Bridge amounts confirmed as OS strings

Phase 8 – Full audit – grep for any remaining number amounts

Phase 9 – All tests updated and passing

Phase 10 – Major version bump, JSDoc updated, examples updated

Final – bun test passes, bun run build succeeds (or equivalent)
