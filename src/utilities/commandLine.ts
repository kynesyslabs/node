import Cryptography from "./cli_libraries/cryptography"
import Wallet from "./cli_libraries/wallet"

const readline = require("readline")

const name = "demos_client"
const version = "alpha"

async function prompt(query = ""): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    })

    return new Promise(resolve =>
        rl.question(query, ans => {
            rl.close()
            resolve(ans)
        }),
    )
}

export default async function commandLine(): Promise<any> {
    console.log("This CLI client is in testing mode")
    // Get input from user
    const breaker = false
    input_loop: while (!breaker) {
        const rawInput = await prompt(name + " - " + version + ":> ")
        // NOTE Dividing arguments if any
        let dividedInput: string[]
        if (rawInput.includes(" ")) {
            dividedInput = rawInput.split(" ")
        } else {
            dividedInput = [rawInput]
        }
        const input = dividedInput[0]
        // ANCHOR Command ingestion
        switch (input.toLowerCase()) {
            // INFO Wallet case is to work with wallets
            case "wallet":
                await Wallet.getInstance().dispatch(dividedInput)
                break
            // TODO Write commands
            case "crypto":
                Cryptography.getInstance().dispatch(dividedInput)
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
