/**
 * Type declarations for circomlibjs
 * Poseidon hash function for ZK circuits
 */

declare module "circomlibjs" {
    /**
     * Field element type (from ffjavascript Fr implementation)
     * Use F.toObject() to convert to bigint
     */
    type FieldElement = Uint8Array | bigint[]

    /**
     * Poseidon hasher instance
     * Note: poseidon_wasm.js returns Uint8Array, poseidon_reference.js returns field elements
     */
    interface Poseidon {
        (inputs: bigint[]): FieldElement
        /**
         * Field operations (from ffjavascript Fr object)
         */
        F: {
            toObject(element: FieldElement): bigint
            toString(element: FieldElement): string
        }
    }

    /**
     * Build Poseidon hasher (WASM implementation, returns Uint8Array)
     * @returns Poseidon instance with field operations
     */
    export function buildPoseidon(): Promise<Poseidon>

    /**
     * Build Poseidon reference (slower, returns field elements not Uint8Array)
     */
    export function buildPoseidonReference(): Promise<Poseidon>
    
    /**
     * Build baby jubjub curve operations
     */
    export function buildBabyjub(): Promise<{
        F: any
        Generator: [bigint, bigint]
        Base8: [bigint, bigint]
        order: bigint
        subOrder: bigint
        mulPointEscalar(point: [bigint, bigint], scalar: bigint): [bigint, bigint]
        addPoint(p1: [bigint, bigint], p2: [bigint, bigint]): [bigint, bigint]
        inSubgroup(point: [bigint, bigint]): boolean
        inCurve(point: [bigint, bigint]): boolean
    }>
    
    /**
     * Build EdDSA operations
     * Note: Library provides multiple verify variants for different hash functions
     */
    export function buildEddsa(): Promise<{
        F: any
        prv2pub(privateKey: Uint8Array): [bigint, bigint]
        sign(privateKey: Uint8Array, message: bigint): { R8: [bigint, bigint], S: bigint }
        verifyPedersen(message: bigint, signature: { R8: [bigint, bigint], S: bigint }, publicKey: [bigint, bigint]): boolean
        verifyMiMC(message: bigint, signature: { R8: [bigint, bigint], S: bigint }, publicKey: [bigint, bigint]): boolean
        verifyPoseidon(message: bigint, signature: { R8: [bigint, bigint], S: bigint }, publicKey: [bigint, bigint]): boolean
        verifyMiMCSponge(message: bigint, signature: { R8: [bigint, bigint], S: bigint }, publicKey: [bigint, bigint]): boolean
    }>
    
    /**
     * Build MiMC sponge hasher
     */
    export function buildMimcSponge(): Promise<{
        F: any
        hash(left: bigint, right: bigint, key: bigint): { xL: bigint, xR: bigint }
        multiHash(arr: bigint[], key?: bigint, numOutputs?: number): bigint[] | bigint
    }>
}
