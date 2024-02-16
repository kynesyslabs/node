import generateLargePrime from "./zkPrimer"
import bigInt from "big-integer"

export class Prover {
    private secret: bigInt.BigInteger
    public modulus: any
    private randomValue: any

    constructor(prime1: any, prime2: any, secret: bigInt.BigInteger = null) {
        this.modulus = prime1.multiply(prime2)
        this.secret = secret
    }

    generateCommitment(): any {
        this.randomValue = bigInt.randBetween(2, this.modulus.subtract(2))
        return this.randomValue.modPow(2, this.modulus)
    }

    respondToChallenge(challenge: number): any {
        return challenge === 0
            ? this.randomValue
            : this.randomValue.multiply(this.secret).mod(this.modulus)
    }
}

export class Verifier {
    private modulus: any
    private commitment: any

    constructor(modulus: any) {
        this.modulus = modulus
    }

    generateChallenge(commitment: any): number {
        this.commitment = commitment
        return Math.round(Math.random())
    }

    verifyResponse(response: any, challenge: number): boolean {
        const responseSquared = response.modPow(2, this.modulus)
        if (challenge === 0) {
            return responseSquared.equals(this.commitment)
        } else {
            return !responseSquared.equals(this.commitment)
        }
    }
}
