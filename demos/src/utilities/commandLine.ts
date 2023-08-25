import * as fs from "fs"
import Wallet from "./cli_libraries/wallet"
import Cryptography from "./cli_libraries/cryptography"
const readline = require("readline")

const NAME = "demos_client"
const VERSION = "alpha"

async function prompt(query=""): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    })

    return new Promise(resolve => rl.question(query, ans => {
        rl.close()
        resolve(ans)
    }))
}

export default async function commandLine(): Promise<any> {
    console.log("This CLI client is in testing mode")
    // Get input from user
    let breaker = false
    input_loop: while (!breaker) {
        let raw_input = await prompt(NAME + " - " + VERSION + ":> ")
        // NOTE Dividing arguments if any
        let divided_input: string[]
        if (raw_input.includes(" ")) {
            divided_input = raw_input.split(" ")
        } else {
            divided_input = [raw_input]
        }
        let input = divided_input[0]
        // ANCHOR Command ingestion
        switch (input.toLowerCase()) {
            // INFO Wallet case is to work with wallets
            case "wallet":
                Wallet.getInstance().dispatch(divided_input)
                break
            // TODO Write commands
            case "crypto":
                Cryptography.getInstance().dispatch(divided_input)
                break
            // TODO Write commands
            case "help":
                break
            case "end":
                break input_loop
            case "exit":
                break input_loop
            case "quit":
                break input_loop
            default:
                console.log("Unknown command: " + input)
                break
        }
    }
    process.exit(0)
}

commandLine()