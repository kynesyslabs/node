/**
 * TLSNotary Verification Module
 *
 * Provides server-side verification of TLSNotary proofs using WASM.
 * Used by GCR identity routines to verify TLSN-based identity claims.
 */
export {
    initTLSNotaryVerifier,
    isVerifierInitialized,
    verifyTLSNotaryPresentation,
    parseHttpResponse,
    verifyTLSNProof,
    extractUser,
    type TLSNIdentityContext,
    type TLSNIdentityPayload,
    type TLSNotaryPresentation,
    type TLSNotaryVerificationResult,
    type ParsedHttpResponse,
    type ExtractedUser,
} from "./verifier"
