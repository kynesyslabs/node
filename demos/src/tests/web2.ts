import { io } from "socket.io-client"
import ComLink from "src/libs/communications/comlink"
import Transmission from "src/libs/communications/transmission"
import { Identity } from "src/libs/identity"
import PeerManager from "src/libs/peer/PeerManager"
import * as fs from "fs"
import * as dotenv from "dotenv"
import peerBootstrap from "src/libs/peer/routines/peerBootstrap"
import { responseRegistry } from "src/libs/communications"

dotenv.config()

const SERVER_PORT = parseInt(process.env.SERVER_PORT, 10) || 53550
const PEER_LIST = JSON.parse(fs.readFileSync("./demos_peers", "utf8"))

const peerManager = PeerManager.getInstance()

// connect to a local socket.io server

const socket = io(`http://localhost:${SERVER_PORT}`)

// handle the event sent with socket.send()

async function testIt() {
    const id = Identity.getInstance()
    await id.ensureIdentity()

    const peerList = await peerBootstrap(PEER_LIST)
    peerManager.setPeerList(peerList)

    const _currentPeer = peerManager.getPeers()[0]

    const comLink = new ComLink()

    let _blockAskMessage = new Transmission(id.ed25519.privateKey)
    _blockAskMessage.initialize(
        "web2Request",
        `{"httpVerb": "GET", "url": "https://google.com", "headers": ""}`,
        id.ed25519.publicKey,
        _currentPeer.identity,
        null,
        null,
    )

    // Hash and sign it
    await _blockAskMessage.finalize()
    // Putting the message into the comlink
    console.log(
        "[SYNC] Asking " + _currentPeer.socket.id + " for the last block",
    )
    // Preparing for a response
    comLink.properties.require_reply = true
    comLink.properties.is_reply = false
    // Propagating the responseRegistry actual status

    responseRegistry.getInstance().requestResponse(comLink)

    // Ask for the last block
    await comLink.broadcastMessageToPeer(
        _currentPeer,
        _blockAskMessage,
        id.ed25519.privateKey as any,
    )

    // Add the response promise to the responses array
    let response = await responseRegistry
        .getInstance()
        .checkResponse(comLink.muid)
    console.log(response)
}

testIt()
