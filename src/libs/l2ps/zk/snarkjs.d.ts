/**
 * Type declarations for snarkjs
 * Minimal types for PLONK proof generation and verification
 */

declare module "snarkjs" {
    export namespace plonk {
        /**
         * Generate a PLONK proof
         * @param input - Witness data (circuit inputs)
         * @param wasmPath - Path to compiled circuit WASM
         * @param zkeyPath - Path to proving key
         * @returns Proof and public signals
         */
        function fullProve(
            input: Record<string, any>,
            wasmPath: string,
            zkeyPath: string
        ): Promise<{
            proof: any
            publicSignals: string[]
        }>
        
        /**
         * Verify a PLONK proof
         * @param verificationKey - Verification key JSON
         * @param publicSignals - Public signals array
         * @param proof - Proof object
         * @returns Whether proof is valid
         */
        function verify(
            verificationKey: any,
            publicSignals: string[],
            proof: any
        ): Promise<boolean>
    }
    
    export namespace groth16 {
        function fullProve(
            input: Record<string, any>,
            wasmPath: string,
            zkeyPath: string
        ): Promise<{
            proof: any
            publicSignals: string[]
        }>
        
        function verify(
            verificationKey: any,
            publicSignals: string[],
            proof: any
        ): Promise<boolean>
    }
    
    export namespace r1cs {
        function info(r1csPath: string): Promise<{
            nConstraints: number
            nVars: number
            nOutputs: number
            nPubInputs: number
            nPrvInputs: number
            nLabels: number
        }>
    }
    
    export namespace zKey {
        function exportVerificationKey(zkeyPath: string): Promise<any>
        function exportSolidityVerifier(zkeyPath: string): Promise<string>
    }
    
    export namespace wtns {
        function calculate(
            input: Record<string, any>,
            wasmPath: string,
            wtnsPath: string
        ): Promise<void>
    }
}
