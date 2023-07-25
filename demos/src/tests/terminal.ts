/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

var prompt = require("prompt-sync")()


import { io } from "socket.io-client"
import * as fs from "fs"
import ComLink from "src/libs/communications/comlink"
import Transmission from "src/libs/communications/transmission"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import ResponseRegistry from "src/libs/communications/responseRegistry"
import { Identity } from "src/libs/identity"
import { Peer } from "src/libs/peer"
import * as demosdk from "./sdk"

let server_test = fs.readFileSync("src/test_server").toString("utf-8")
let server_url = server_test.split(">")[0].replace("\"", "") + ":" + server_test.split(">")[1]
let rpc = new Peer()

// NOTE Sleep function
async function sleep(ms: number) {
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    })
}

// NOTE listeners 
async function setListeners (){

    rpc.socket.on("connect", async () => {
        console.log("[CONNECT EVENT]")
        console.log("Connected to server")
    })

    rpc.socket.on("comlink" , async (data) => {
        console.log("[COMLINK EVENT]")
        console.log(data)
    })

    rpc.socket.on("comlink_reply", async (data) => {
        console.log("[COMLINK REPLY EVENT]")
        let _comlink = new ComLink()
        _comlink.chain = data.chain
        _comlink.muid = data.muid
        _comlink.properties = data.properties
        let valid = await _comlink.validateComlink()
        if (valid) {
            console.log("[COMLINK REPLY IS VALID]")
            ResponseRegistry.getInstance().registerResponse(_comlink.chain.current.currentMessage, _comlink.muid, rpc.socket)
        } else {
            console.log("[COMLINK REPLY IS INVALID]")
        }
    })

    // SECTION Authentication procedure
    rpc.socket.on("auth_ask", async (data) => {
        console.log("[AUTH ASK EVENT]")
        console.log(data)
        let signature = Cryptography.sign(data, Identity.getInstance().ed25519.privateKey)
        console.log("[SIGNING THE AUTH ASK MESSAGE] " + signature.toString("hex"))
        let _sendBack = [
            data,
            signature,
            Identity.getInstance().ed25519.publicKey,
        ]
        console.log("< SENDING BACK OUR IDENTITY >")
        rpc.socket.emit("auth_reply", _sendBack)
    })

    rpc.socket.on("auth_ok", async (data) => {
        console.log("[AUTH OK EVENT]")
        console.log(data)
        let _valid_signature = Cryptography.verify("auth_ok", data.signature, data.identity)
        if (!_valid_signature) {
            console.log("[AUTH BAD SIGNATURE]")
            return
        }
        console.log("[VALID SIGNATURE]: " + data.signature.toString("hex"))
        rpc.identity = data.identity
        console.log("[FINISHED AUTHENTICATION] RPC SERVER:")
        console.log(rpc.identity.toString("hex"))
    })
	
    rpc.socket.on("auth_reply", async (data) => {
        console.log("[AUTH REPLY EVENT]")
        console.log(data)
    })
    // !SECTION Authentication procedure

    rpc.socket.on("public", async (data) => {
        console.log("[PUBLIC EVENT]")
        console.log(data)
    })

    rpc.socket.on("error", async (data) => {
        console.log("[ERROR EVENT]")
        console.log(data)
    })

    rpc.socket.on("disconnect", async () => {
        console.log("[DISCONNECT EVENT]")
        console.log("Disconnected from server")
    })

}

// NOTE Testing some nodeCalls here
async function testNodeCalls(){
    // TODO
    console.log("[TESTING NODE CALLS]")
    let comlink = new ComLink()
    let message = new Transmission(Identity.getInstance().ed25519.privateKey)
    console.log("[TYPES CREATED]")
    message.initialize(
        "nodeCall",
        "getLastBlockNumber",
        Identity.getInstance().ed25519.publicKey,
        rpc.identity,
        null,
        null,
    )
    console.log("[MESSAGE INITIALIZED]")
    await message.finalize()

    comlink.properties.is_reply = false
    comlink.properties.require_reply = true
    ResponseRegistry.getInstance().requestResponse(comlink)
    console.log(ResponseRegistry.getInstance())
    console.log("[RESPONSE REQUESTED]")
	
    console.log("[BROADCASTING THE MESSAGE TO THE RPC SERVER]")
    await comlink.broadcastMessageToPeer(rpc, message, Identity.getInstance().ed25519.privateKey)
    console.log("[FINISHED BROADCASTING THE MESSAGE TO THE RPC SERVER, WAITING FOR REPLY]")
    let resp_status = await ResponseRegistry.getInstance().checkResponse(comlink.muid)
    if (!resp_status[0]) { 
        console.log("[ERROR IN RESPONSE]")
        console.log(resp_status) 
        return
    } 
    console.log("[RESPONSE RECEIVED]")
    console.log(resp_status[1].message)

    console.log("\n=== Explanation ===")
    console.log("This test shows the correct handshake, request and response between a client and a node (or two nodes).")
	
}

// NOTE Testing crosschain here
async function testCrosschain(){

    // NOTE Let's connect to two chains
    const evm = demosdk.EVM.createInstance(1, "https://rpc.ankr.com/eth")

    const xrpl = new demosdk.XRPL()
    xrpl.connect("wss://xrpl.ws/")


    // ANCHOR Experiments!

    // INFO Adjust this value > 1 to have an outcome on the other chain or < 1 to have another outcome
    let treshold_balance = 1.5

    // NOTE Let's set the accounts to read from during this example
    let ripple_outcome_1 = "rMQ98K56yXJbDGv49ZSmW51sLn94Xe1mu1"
    let ripple_outcome_2 = "rUeDDFNp2q7Ymvyv75hFGC8DAcygVyJbNF"
    let evm_address = "0x00000000219ab540356cbb839cbe05303d7705fa"

    // NOTE Preparing a variable to store the outcome
    let chosen_ripple_account: string

    // INFO Reading from ETH Mainnet
    console.log("Checking EVM balance...")
    let evm_balance_outcome = await evm.getBalance(evm_address)
    let evm_balance = parseFloat(evm_balance_outcome)
    console.log("EVM Balance is: " + evm_balance)

    // NOTE Calculating the treshold and the outcome
    let treshold = evm_balance * treshold_balance
    console.log("Treshold is: " + treshold)
    if ((evm_balance/2) < treshold) {
        chosen_ripple_account = ripple_outcome_1
        console.log("EVM balance is less than treshold, choosing account: " + chosen_ripple_account)
    } else {
        chosen_ripple_account = ripple_outcome_2
        console.log("EVM balance is greater than treshold, choosing account: " + chosen_ripple_account)
    }

    // INFO Reading from XRPL Mainnet based on the result of the ETH Mainnet data
    console.log("Getting XRPL balance...")
    let chosen_ripple_balance = await xrpl.getBalance(chosen_ripple_account, false)
    console.log("Balance of chosen account: " + chosen_ripple_balance)

    // TODO Add a write example with read on a eth sc and sending ripple around

}

// NOTE Testing web2 here
async function testWeb2(){
    // TODO
}

// NOTE Entry Point
async function main() {
    // Loading identity
    await Identity.getInstance().ensureIdentity()
    console.log("[IDENTITY LOADED] " + Identity.getInstance().ed25519.publicKey.toString("hex"))
    console.log("[TESTING SERVER] " + server_url)
    console.log("\n================================================================\n")
    rpc.socket = io(server_url)
    rpc.connectionString = server_url
    await setListeners()
    let timeout = 5000
    while(!rpc.identity) {
        await sleep(100)
        timeout -= 100
        if (timeout <= 0) {
            console.log("[TIMEOUT REACHED]")
            break
        }
    }
    console.log("[SOCKET CONNECTED] " + rpc.socket.connected)
    interactive() // Not awaiting as it is in the background
}

// NOTE Interactive method
async function interactive() {
    let key
    while (!(key=="exit")) {
        console.log("\n")
        key = await prompt("[demosClient] :> ")
        switch (key) {
            default:
                console.log("Invalid command (digit help for help)")
                break
            case "help":
                console.log("Help File")
                console.log("[help] Show this help")
                console.log("[nodecall] Execute a node call test")
                console.log("[crosschain] Execute a crosschain test")
                console.log("[web2] Execute a web2 test")
                console.log("[all] Execute all tests")
                console.log("[exit] Exit")
                break
            case "nodecall":
                await testNodeCalls()
                break
            case "crosschain":
                await testCrosschain()
                break
            case "web2":
                await testWeb2()
                break
            case "all":
                await testNodeCalls()
                await testCrosschain()
                await testWeb2()
                break
        }
    }
    console.log("Exiting...")
    process.exit(0)
}

main()