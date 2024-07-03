import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import { PeerManager } from "src/libs/peer"
import required from "src/utilities/required"
import sharedState from "src/utilities/sharedState"
import terminalKit from "terminal-kit"

import {
  IWeb2Attestation,
} from "@kynesyslabs/demosdk/types"

import { DAHR } from "./dahr/DAHR"

const term = terminalKit.terminal

export class Web2RequestManager {
  /**
   * Creates a new instance of the Web2RequestManager class.
   *
   * @param {DAHR} dahr - An instance of the DAHR class. This parameter is required.
   * @throws {Error} Will throw an error if the `dahr` parameter is not provided.
   */
  constructor(private dahr: DAHR) {
      required(this.dahr, "Missing DAHR instance")
  }

  /**
   * Attest the result.
   * @param {any} result - The HTTP result to attest.
   * @returns {Promise<IWeb2Attestation>} The attestation.
   */
  attest(result: any): Promise<IWeb2Attestation> {
      const attestation = this.getAttestation(result)
      this.dahr.web2Request.raw.stage.hopNumber += 1 
      return attestation
  }

  /**
   * Validate the result.
   * @param {any} result - The result to validate.
   * @returns {Promise<IWeb2Attestation>} Returns an attestation.
   */
  async getAttestation(result: any): Promise<IWeb2Attestation> {
      term.yellow.bold("[Web2Parser] Validating...\n")
      const stringedResult = JSON.stringify(result)

      // Hashing and signing the result
      const hashedResult = Hashing.sha256(stringedResult)
      this.dahr.web2Request.hash = hashedResult
      term.bold("[Web2Parser] Result:\n")
      console.log(hashedResult)
      const signature = Cryptography.sign(
          hashedResult,
          sharedState.getInstance().identity.ed25519.privateKey,
      )
      this.dahr.web2Request.signature = signature

      // Composing our attestation
      const attestation: IWeb2Attestation = {
          hash: hashedResult,
          timestamp: Date.now(),
          identity: sharedState.getInstance().identity.ed25519.publicKey,
          signature: signature,
          valid: null,
      }
      term.bold("[Web2Parser] Attestation:\n")
      console.log(attestation)
      // Adding the attestation to the web2Request
      const hexKey = sharedState
          .getInstance()
          .identity.ed25519.publicKey.toString("hex") // REVIEW Is this ok?
      this.dahr.web2Request.attestations[hexKey] = attestation
      term.bold("[Web2Parser] Added attestation to web2Request\n")
      // And the content too
      // REVIEW If we are not the first hop, we should not overwrite the original result
      /*
       * The questionable logic is that the .result property should be lazy static, that means
       * that it should be set only when it is actually needed (aka at the beginning) but
       * is not really protected as there is no advantage of editing it in the middle of the process.
       *
       * At the end of the process, the result is anyway compared with the various attestations
       * within the validators array.
       *
       */
      if (this.dahr.web2Request.result === undefined) {
        this.dahr.web2Request.result = result
      }

      return attestation
  }

  /**
   * Verify the web2Request based on the attestations. Checking attestations (one by one) and returning the result of the verification
   * @returns {Promise<boolean>} Whether the request is valid.
   */
  async verify(): Promise<boolean> {
      required(this.dahr.web2Request, "Missing request")
      let valid = true
      // Cycling through all the attestations
      for (const key of Object.keys(this.dahr.web2Request.attestations)) {
          const attestation = this.dahr.web2Request.attestations[key]
          // REVIEW Checking the hash validity for all the attestations
          const stringifiedContent = JSON.stringify(this.dahr.web2Request.raw)
          const hash = Hashing.sha256(stringifiedContent)
          const hashIsValid = hash === attestation.hash
          // REVIEW Checking the signature validity for all the attestations
          const signatureIsValid = Cryptography.verify(
              attestation.signature.toString("hex"),
              attestation.hash,
              attestation.identity,
          )
          // Noting the result of the verification in the attestation array
          const isValid = hashIsValid && signatureIsValid
          attestation.valid = isValid
          // If the attestation is not valid, the whole request is not valid and while
          // we continue to cycle through the attestations, we can already set the
          // request as not valid
          if (!isValid) {
              valid = false
          }
          this.dahr.web2Request.attestations[key] = attestation
      }

      return valid
  }

  /**
   * Broadcast the request to another peer.
   */
  async next(): Promise<void> {
      required(this.dahr.web2Request, "Missing request")
      // Selecting a random peer (just one)
      const peerList = PeerManager.getInstance().getPeers()
      const peer = peerList[Math.floor(Math.random() * peerList.length)]
      // Forwarding the request to the selected peer

      // TODO Send the request to the next peer
  }
  
  /**
   * @returns {number} The number of attestations.
   */
  getNumberOfAttestations(): number {
      return Object.keys(this.dahr.web2Request.attestations).length
  }

  /**
   * Wait for the attestations to arrive. The role of this method is to help the original rpc 
   * receiving the web2 request to wait (with a customizable timeout) for the attestations to 
   * arrive. The whole web2 on chain structure is designed to be as much asynchronous as possible,
   * so the receiving rpc needs to be able to wait without blocking all its services.
   *
   * This method is based on the idea that the original rpc should be agnostic to the
   * actual position of the request in the attestation process, and should only wait for
   * the attestations to arrive.
   * @param {number} quorum - The quorum.
   * @param {number} timeout - The timeout.
   * @returns {Promise<boolean>} Whether the quorum is reached.
   */
  async quorumIsReached(quorum: number = 10, timeout: number = 9000): Promise<boolean> {
      let reachedQuorum: boolean = false
      let timer: number = 0
      // NOTE We wait for timeout seconds before surrendering
      while (timer < timeout) {
          await new Promise(resolve => setTimeout(resolve, 100)) // Each 100 ms we can check for updates
          if (this.getNumberOfAttestations() >= quorum) {
              reachedQuorum = true
              break
          }
          timer += 100
      }
      return reachedQuorum
  }
}