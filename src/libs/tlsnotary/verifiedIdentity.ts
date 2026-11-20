/**
 * A TLSN identity link under the `tlsnVerified` fork, judged the same way at
 * admission and at block apply: the presentation (presentationGate), its
 * transcript (identityPolicy), the tlsn_request the bind header names, and
 * the links already on chain. The request is the on-chain token its
 * `tlsn_request` wrote, and a link uses it up as a store does, so one
 * request backs exactly one attestation.
 *
 * Inside block apply every check reads the block's own time and the chain
 * as of the tip, so all nodes reach the same verdict. A node that cannot
 * reach one (its verifier cannot run, a state read fails) must not decide
 * either way: at apply it throws a StateReadError, which keeps the block
 * from applying here (the node sits the round out, as for any failed state
 * read) instead of recording a failure the other nodes do not record. At
 * admission it refuses with a reason that says to retry.
 */
import { getSharedState } from "@/utilities/sharedState"
import { blockTimeSec } from "@/libs/blockchain/gcr/applyTime"
import { StateReadError } from "@/libs/blockchain/gcr/stateReadError"
import { sameWeb2UserId } from "@/libs/identity/web2UserId"
import { judgePresentation } from "./presentationGate"
import {
    bindSenderForm,
    judgeIdentityTranscript,
    tlsnIdentityEndpoint,
    tlsnIdentityEndpoints,
} from "./identityPolicy"
import { keylessWeb2IdentityActive } from "@/forks/keylessWeb2IdentityGate"
import { TlsnVerifierUnavailableError } from "./wasmVerifier"
import { findTlsnLinkHits, findTlsnRequest, tipBlockTimestampSec } from "./tlsnChainReads"
import { tlsnRequestOf, tlsnRequestRefusal, type TlsnRequestRefusal } from "./onchainRequests"
import type { GCRTLSNotary } from "@/model/entities/GCRv2/GCR_TLSNotary"

/** The verifier could not run while a block applied: no verdict, no block. */
export class TlsnVerifierUnavailableAtApplyError extends StateReadError {
    constructor(cause: unknown) {
        super("TLSNotary verifier", cause)
        this.name = "TlsnVerifierUnavailableAtApplyError"
    }
}

/** An account as the link rules read it: only its stored web2 links. */
interface LinkHolder {
    pubkey: string
    identities?: { web2?: Record<string, unknown> } | null
}

export interface VerifiedIdentityInput {
    context: string
    /** The tlsn-js presentation: `data` is the hex of its bytes. */
    proof: unknown
    username: string
    userId: string
    /** The transaction sender (its ed25519 address). */
    sender: string
    /** Accounts this block (or this admission) already holds in memory. */
    accounts?: Iterable<LinkHolder>
    /** Token rows this block (or this admission) already holds in memory, by token id. */
    tokens?: ReadonlyMap<string, GCRTLSNotary | null>
}

export interface VerifiedIdentityResult {
    success: boolean
    message: string
    extractedUsername?: string
    extractedUserId?: string
    attestationId?: string
    serverName?: string
    /** The token row the link uses, as found: the caller marks it used. */
    token?: GCRTLSNotary
    /** Set on a refusal that says nothing about the transaction. */
    retryable?: boolean
}

const refuse = (message: string): VerifiedIdentityResult => ({ success: false, message })

const REQUEST_REFUSALS: Record<TlsnRequestRefusal, string> = {
    NOT_FOUND: "names no tlsn_request on chain",
    OWNER_MISMATCH: "names a tlsn_request of another account",
    DOMAIN_MISMATCH: "names a tlsn_request for another server",
    EXPIRED: "names an expired tlsn_request",
    ALREADY_USED: "names a tlsn_request already used",
}

function linksOf(holder: LinkHolder, context: string): Record<string, unknown>[] {
    const web2 = holder.identities?.web2
    if (!web2 || typeof web2 !== "object" || !Object.hasOwn(web2, context)) return []
    const bucket = web2[context]
    return Array.isArray(bucket) ? (bucket as Record<string, unknown>[]) : []
}

async function judge(input: VerifiedIdentityInput, applying: boolean): Promise<VerifiedIdentityResult> {
    const { context, sender } = input
    // Judged at the tip like the other apply-time rules: block N applies on
    // tip N - 1, and admission judges for the block after the tip.
    const height = getSharedState.lastBlockNumber ?? 0
    const endpoints = tlsnIdentityEndpoints(keylessWeb2IdentityActive(height))
    if (!tlsnIdentityEndpoint(context, endpoints)) {
        return refuse(`TLSN context ${context} cannot be linked with a TLSNotary proof`)
    }
    if (typeof sender !== "string" || sender.length === 0) {
        return refuse("TLSN identity link has no sender")
    }
    const proof = input.proof as { data?: unknown } | null
    if (!proof || typeof proof !== "object") {
        return refuse("Invalid proof: expected TLSNotary presentation object")
    }

    const blockTime = applying ? (blockTimeSec() as number) : await tipBlockTimestampSec()

    const verdict = judgePresentation(proof.data, { height, blockTimeSec: blockTime })
    if (verdict.ok === false) return refuse(`Proof verification failed: ${verdict.reason}`)

    const identity = judgeIdentityTranscript(verdict.presentation, context, sender, endpoints)
    if (identity.ok === false) return refuse(`Proof verification failed: ${identity.reason}`)
    const facts = identity.facts

    if (facts.username !== input.username) {
        return refuse(`Username mismatch: claimed '${input.username}', proof contains '${facts.username}'`)
    }
    if (facts.userId !== String(input.userId)) {
        return refuse(`UserId mismatch: claimed '${String(input.userId)}', proof contains '${facts.userId}'`)
    }

    // The request must be this sender's, for this server, on chain and
    // unused, so a presentation made under one request or for one account
    // cannot serve another, and one request backs one attestation.
    const token = await findTlsnRequest(facts.bind.requestTxHash, input.tokens)
    const request = tlsnRequestOf(token)
    const refusal = tlsnRequestRefusal(request, {
        sender: bindSenderForm(sender),
        // The height of the block the link lands in.
        height: height + 1,
        domain: facts.serverName,
        pendingOnly: true,
    })
    if (refusal) return refuse(`X-Demos-Bind ${REQUEST_REFUSALS[refusal]}`)

    // Links held in memory are this block's current state; the database is
    // read only for the accounts not among them.
    const held = new Set<string>()
    for (const holder of input.accounts ?? []) {
        held.add(holder.pubkey)
        for (const link of linksOf(holder, context)) {
            if (link.attestationId === facts.attestationId) {
                return refuse("this attestation already linked an identity")
            }
            if (
                bindSenderForm(holder.pubkey) !== bindSenderForm(sender) &&
                (link.userId === facts.userId || sameWeb2UserId(link.userId, facts.userId))
            ) {
                return refuse(`${context} account ${facts.userId} is linked to another account`)
            }
        }
    }
    const hits = await findTlsnLinkHits({
        context,
        userId: facts.userId,
        attestationId: facts.attestationId,
        account: sender,
        skip: [...held],
    })
    if (hits.attestationUsed) return refuse("this attestation already linked an identity")
    if (hits.userIdLinked) return refuse(`${context} account ${facts.userId} is linked to another account`)

    return {
        success: true,
        message: "TLSNotary presentation verified",
        extractedUsername: facts.username,
        extractedUserId: facts.userId,
        attestationId: facts.attestationId,
        serverName: facts.serverName,
        token: token!,
    }
}

/**
 * Judges a TLSN identity link under the fork. Inside block apply (a block
 * time is set) a missing verdict throws a StateReadError; outside it, the
 * same failure is a retryable refusal.
 */
export async function verifyTlsnIdentity(input: VerifiedIdentityInput): Promise<VerifiedIdentityResult> {
    const applying = blockTimeSec() !== undefined
    try {
        return await judge(input, applying)
    } catch (error) {
        if (applying) {
            if (error instanceof TlsnVerifierUnavailableError) {
                throw new TlsnVerifierUnavailableAtApplyError(error.message)
            }
            // A StateReadError stops the block. Anything else follows from
            // the transaction alone and fails it, as any edit that throws.
            throw error
        }
        const why =
            error instanceof TlsnVerifierUnavailableError
                ? "the TLSNotary verifier is unavailable on this node"
                : error instanceof StateReadError
                  ? "chain state could not be read"
                  : "the TLSNotary proof could not be judged"
        return {
            success: false,
            retryable: true,
            message: `${why}; try again later (${error instanceof Error ? error.message : String(error)})`,
        }
    }
}
