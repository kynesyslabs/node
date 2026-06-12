// Jest stand-in for `@kynesyslabs/demosdk/utils` (ESM, not transformed by
// ts-jest). Mirrors the real implementations in
// node_modules/@kynesyslabs/demosdk/build/utils so behaviour-sensitive
// helpers (denomination math, address validation) stay faithful.

const OS_DECIMALS = 9

/** Mirror of `denomination/conversion.js` demToOs — 1 DEM = 10^9 OS. */
export function demToOs(dem: number | string): bigint {
    const str = (typeof dem === "number" ? dem.toString() : dem).replace(
        /_/g,
        "",
    )
    const [whole, frac = ""] = str.split(".")
    if (frac.length > OS_DECIMALS) {
        throw new Error(
            `DEM amount "${str}" exceeds maximum ${OS_DECIMALS} decimal places`,
        )
    }
    const paddedFrac = frac.padEnd(OS_DECIMALS, "0")
    const result = BigInt(`${whole}${paddedFrac}`)
    if (result < 0n) {
        throw new Error(`Negative amounts not allowed: ${str}`)
    }
    return result
}

export function validateEd25519Address(address: string): boolean {
    return /^0x[0-9a-f]{64}$/i.test(address)
}

export function deserializeUint8Array(base64: string): Uint8Array {
    const binary = atob(base64)
    const u8 = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        u8[i] = binary.charCodeAt(i)
    }
    return u8
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
