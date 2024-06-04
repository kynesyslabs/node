import * as forge from "node-forge"

export default interface IPartecipant {
    id: string // Internal ID within the L2PS
    publicKey: forge.pki.ed25519.BinaryBuffer | forge.pki.PublicKey // Public key of the partecipant
}