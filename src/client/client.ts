// INFO This is the main client for any user that want to interact with DEMOS with the command line

import * as socket from "socket.io"
import * as socket_client from "socket.io-client"
import * as readline from "readline"
import Client from "./libs/client_class"

// NOTE Initializing client
let client = new Client()

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
    let exit_flag = false
    while (!exit_flag) {
        let answer = await ask(
            "DEMOS Client (Alpha)[" +
                client.STATUS_PROMPT +
                " | " +
                client.STATUS_FLAG +
                "] \n> ",
        )
        if (answer === "exit") {
            exit_flag = true
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
    let cmd_type: string
    let cmd_args: string[]
    let cmd_split: string[]
    if (cmd.includes(" ")) {
        cmd_split = cmd.split(" ")
        cmd_type = cmd_split[0]
        cmd_args = cmd_split.slice(1)
    } else {
        cmd_type = cmd
        cmd_args = []
    }
    // Now we can parse the command and dispatch things to the client class methods
    switch (cmd_type) {
        case "help":
            console.log("Available commands:")
            console.log("  help - Show this help")
            console.log("  exit - Exit the client")
            break
        case "connect":
            // NOTE Connecting to the server requires an url to be specified
            if (cmd_args.length === 0) {
                console.log("You must specify an url to connect to!")
                break
            }
            await client.connect(cmd_args[0])
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
