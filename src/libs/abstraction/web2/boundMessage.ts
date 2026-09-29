/**
 * What a web2 identity proof signs.
 *
 * The legacy proof signs the constant `"dw2p"`. The signature is checked
 * against the transaction sender, so it does prove the Demos key took part —
 * but it says nothing about WHICH handle is being claimed, and the payload is
 * published in the post itself.
 *
 * That is enough to claim a handle you do not own. The proof text sits in a
 * public tweet/gist/message; anyone who quotes, forwards or copies it puts a
 * valid proof under their own handle, and the signer can then claim that
 * handle as their identity — the node only checks that the post exists and
 * carries a signature by the sender. Linked identities gate incentives and
 * reputation, so the claim has value.
 *
 * Binding the context, the claimed handle and the sender into the signed
 * message makes a proof usable for exactly the claim it was made for. The
 * `domain` context already does this (`dacs-domain:v1:<host>:<sender>`); this
 * is the same idea for the remaining contexts.
 *
 * Must stay in lockstep with the SDK's `createWeb2ProofPayload`.
 */
export const WEB2_PROOF_DOMAIN = "demos-web2:v1"

/**
 * @param context - Proof context (`twitter`, `github`, `discord`).
 * @param username - The handle being claimed, as the payload declares it.
 * @param sender - The ed25519 address the identity is being attached to.
 */
export function web2BoundProofMessage(
    context: string,
    username: string,
    sender: string,
): string {
    return `${WEB2_PROOF_DOMAIN}:${context}:${username.toLowerCase()}:${sender.toLowerCase()}`
}
