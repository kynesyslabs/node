/**
 * Type declarations for circomlibjs
 * Poseidon hash function for ZK circuits
 */

declare module "circomlibjs" {
    /**
     * Poseidon hasher instance
     */
    interface Poseidon {
        (inputs: bigint[]): Uint8Array
        F: {
            toObject(element: Uint8Array): bigint
            toString(element: Uint8Array): string
        }
    }
    
    /**
     * Build Poseidon hasher
     * @returns Poseidon instance with field operations
     */
    export function buildPoseidon(): Promise<Poseidon>
    
    /**
     * Build Poseidon reference (slower but simpler)
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
     */
    export function buildEddsa(): Promise<{
        F: any
        prv2pub(privateKey: Uint8Array): [bigint, bigint]
        sign(privateKey: Uint8Array, message: bigint): { R8: [bigint, bigint], S: bigint }
        verify(message: bigint, signature: { R8: [bigint, bigint], S: bigint }, publicKey: [bigint, bigint]): boolean
    }>
    
    /**
     * Build MiMC sponge hasher
     */
    export function buildMimcSponge(): Promise<{
        F: any
        hash(left: bigint, right: bigint, key: bigint): bigint
        multiHash(arr: bigint[], key?: bigint, numOutputs?: number): bigint[]
    }>
}
