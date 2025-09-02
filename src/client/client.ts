// INFO This is the main client for any user that want to interact with DEMOS with the command line

import * as readline from "readline"

import Client from "./libs/client_class"

// NOTE Initializing client
const client = new Client()

// NOTE Creating a readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
})

// INFO Easy async based readline method
async function ask(message: string): Promise<string> {
     
    return new Promise((resolve, reject) => {
        rl.question(message, answer => {
            rl.close()
            resolve(answer)
        })
    })
}

// INFO Entry point
async function main() {
    // NOTE Constant prompting
    let exitFlag = false
    while (!exitFlag) {
        const answer = await ask(
            "DEMOS Client (Alpha)[" +
                client.STATUS_PROMPT +
                " | " +
                client.STATUS_FLAG +
                "] \n> ",
        )
        if (answer === "exit") {
            exitFlag = true
        } else {
            //console.log(answer)
            await parser(answer)
        }
    }
    rl.close()
    process.exit(0)
}

async function parser(cmd: string) {
    // First, we divide the command by spaces
    let cmdType: string
    let cmdArgs: string[]
    let cmdSplit: string[]
    if (cmd.includes(" ")) {
        cmdSplit = cmd.split(" ")
        cmdType = cmdSplit[0]
        cmdArgs = cmdSplit.slice(1)
    } else {
        cmdType = cmd
        cmdArgs = []
    }
    // Now we can parse the command and dispatch things to the client class methods
    switch (cmdType) {
        case "help":
            console.log("Available commands:")
            console.log("  help - Show this help")
            console.log("  exit - Exit the client")
            break
        case "connect":
            // NOTE Connecting to the server requires an url to be specified
            if (cmdArgs.length === 0) {
                console.log("You must specify an url to connect to!")
                break
            }
            await client.connect(cmdArgs[0])
            break
        case "disconnect":
            // NOTE Disconnecting from the server
            client.disconnect()
            break
        default:
            break
    }
}

main()
