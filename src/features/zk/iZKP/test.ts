import bigInt from "big-integer"
import terminalkit from "terminal-kit"

import { Prover, Verifier } from "./zk"
import generateLargePrime from "./zkPrimer"

const term = terminalkit.terminal

// EXAMPLE

async function testing() {
    // Start a timer to measure the time it takes to run the protocol
    const start = Date.now()

    console.log("[PROTOCOL] Generating primes....")
    // Generate two large primes for the protocol
    console.log("[PROTOCOL] 0/2....")
    const prime1 = generateLargePrime(2048, 5)
    console.log(prime1.toString())
    console.log("[PROTOCOL] 1/2....")
    const prime2 = generateLargePrime(2048, 5)
    console.log(prime2.toString())
    console.log("[PROTOCOL] 2/2....")
    console.log("[PROTOCOL] Done. Primes are generated.")

    console.log("\n\n")
    // The password is the secret that the Prover knows
    const password = "mySecretPassword"
    // console.log("[PROVER] Password: " + password);
    console.log("[PROVER] Converting password...")
    // Convert the password to a big integer to use in the protocol
    const passwordAsBigInt = bigInt(password, 36)
    //console.log("[PROVER] Password as BigInt: " + passwordAsBigInt.toString());
    console.log(
        "[PROVER] Creating a prover with the above primes and the bigInt password...",
    )
    // Create a Prover with the password as the secret
    const prover = new Prover(prime1, prime2, passwordAsBigInt)
    console.log("[PROVER] Done. Prover is created.")

    term.yellow(
        "\n[PROVER -> VERIFIER] 'Hey, I know the password! Here's my modulus!\n\n",
    )

    console.log("[VERIFIER] Creating a verifier with the prover modulus...")
    // Create a Verifier with the Prover's modulus
    const verifier = new Verifier(prover.modulus)
    console.log("[VERIFIER] Done. Verifier is created.")

    term.yellow("\n[VERIFIER -> PROVER] 'Okay, prove it!'\n\n")

    console.log("[PROVER] Generating commitment...")
    // The Prover generates a commitment
    const commitment = prover.generateCommitment()
    //console.log("[PROVER] Commitment: " + commitment.toString());

    term.yellow("\n[PROVER -> VERIFIER] 'Here's my commitment!'\n\n")

    // The Verifier generates a challenge
    console.log("[VERIFIER] Generating challenge...")
    const challenge = verifier.generateChallenge(commitment)
    //console.log("[VERIFIER] Challenge: " + challenge.toString());

    term.yellow(
        "\n[VERIFIER -> PROVER] 'And here is your challenge, based on your commitment!'\n\n",
    )

    console.log("[PROVER] Responding to challenge...")
    // The Prover responds to the challenge
    const response = prover.respondToChallenge(challenge)
    //console.log("[PROVER] Response: " + response.toString());

    term.yellow("\n[PROVER -> VERIFIER] 'Here is my response!'\n\n")

    console.log("[VERIFIER] Verifying response...")
    // The Verifier verifies the response
    const isVerified = verifier.verifyResponse(response, challenge)
    console.log("[VERIFIER] Verification result: " + isVerified.toString())

    if (isVerified) {
        term.green("\n[VERIFIER] 'You are verified!'\n\n")
    } else {
        term.red("\n[VERIFIER] 'You are not verified!'\n\n")
    }

    // Stop the timer
    const end = Date.now()
    const timeTaken = end - start
    console.log("Time taken: " + timeTaken + "ms")
}

testing()
