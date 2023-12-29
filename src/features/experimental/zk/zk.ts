import generateLargePrime from "./zkPrimer"
import * as bigInt from "big-integer"

/* NOTE
    Terminology:
    * toy = secret
    * magicalBox = N = p * q
*/

class Prover {
    private magicalToy: any   // This is the special toy Prover is hiding
    public magicalBox: any    // The box that can hide the toy (N = p * q)
    private secretKey: any    // The key that makes the toy appear

    constructor(lock1: any, lock2: any, secret: any = null) {
        this.magicalBox = lock1.multiply(lock2)
        // Support for random on the fly secrets
        if (!secret) {
            this.magicalToy = bigInt.randBetween(2, this.magicalBox.subtract(2)) // Choosing a toy randomly
        }
    }
    
    // Prover puts the toy in the magical box
    lockToyInBox(): any {
        this.secretKey = bigInt.randBetween(2, this.magicalBox.subtract(2))
        return this.secretKey.modPow(2, this.magicalBox)
    }

    // Prover either just opens the box or uses the special key, depending on Verifier's coin flip
    showMagicOrOpen(challengeCoin: number): any {
        return challengeCoin === 0 ? this.secretKey : this.secretKey.multiply(this.magicalToy).mod(this.magicalBox)
    }
}

class Verifier {
    private magicalBox: any // NOTE The verifier possess N (the magical box) but not the toy
    private lockedBox: any // NOTE That's what the Prover provides

    constructor(magicalBox: any) {
        this.magicalBox = magicalBox
    }

    // Verifier flips a coin to challenge the Prover
    flipCoin(lockedBoxReceived: any): number {
        this.lockedBox = lockedBoxReceived
        return Math.round(Math.random())
    }

    // Verifier checks if Prover really did the magic trick or just opened the box
    isItReallyMagic(response: any, challengeCoin: number): boolean {
        const magicValue = response.modPow(2, this.magicalBox)

        if (challengeCoin === 0) {
            return magicValue.equals(this.lockedBox)
        } else {
            // Checking if Prover did the magic trick without showing the toy
            return !magicValue.equals(this.lockedBox)
        }
    }

}


// Let's play the magic game:
function magicGame() {
    // NOTE Generating the magical box locks
    console.log("Generating the magical box locks...")
    console.log("\n")
    const lock1 = generateLargePrime(2048, 5)  // Pieces of the magical box's lock.
    console.log("Lock 1: " + lock1.toString()) 
    const lock2 = generateLargePrime(2048, 5)
    console.log("Lock 2: " + lock2.toString())
    
    // NOTE Initiating a Prover with the two locks
    const prover = new Prover(lock1, lock2)
    // NOTE As N (magicalBox) is now known, let's inform a Verifier about it
    const verifier = new Verifier(prover.magicalBox)

    // NOTE The prover locks the toy and gets a locked box
    const lockedBox = prover.lockToyInBox()
    // NOTE Now the verifier will flip a coin to challenge the prover 
    const challengeCoin = verifier.flipCoin(lockedBox)   // Verifier flips a coin
    const magicOrOpenAction = prover.showMagicOrOpen(challengeCoin) // Prover either shows magic or just opens the box
    const isMagicConfirmed = verifier.isItReallyMagic(magicOrOpenAction, challengeCoin)  // Verifier decides if he saw magic

    console.log(`Did Verifier see the magic?: ${isMagicConfirmed}`)
    return isMagicConfirmed
}

function runMultipleTimes(n: number): Boolean {
    let results: Boolean[] = []
    for (let i = 0; i < n; i++) {
        let res = magicGame()
        if (!res) {
            console.log("Verification failed at attempt " + n.toString() + "!")
            return false
        }
        results.push(res)
    }
   //console.log(results)
    return true
}


runMultipleTimes(5)