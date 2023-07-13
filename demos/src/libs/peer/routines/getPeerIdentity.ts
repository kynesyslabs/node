import Peer from "../Peer"
import ComLink from "../../communications/comlink"
import Transmission from "../../communications/transmission"
import { responseRegistry } from "../../communications"
import { Socket } from 'socket.io';


export default async function getPeerIdentity(peer: Peer, id: any): Promise<Peer> {
	// A peer object must have a valid socket
	if (!peer.socket) {
		return null;
	}
	// Asking the peer for its identity
	let comlink = new ComLink()
	let identity_ask = new Transmission(id.privateKey)
	identity_ask.initialize(
		"nodeCall",
		"getPeerIdentity",
		id.publicKey,
		"placeholder",
		null,
		null,
	)
	await identity_ask.finalize()
	comlink.properties.require_reply = true
	comlink.properties.is_reply = false
	// Adding the response request
	responseRegistry.getInstance().requestResponse(comlink)
	// Broadcasting the request
	await comlink.broadcastMessageToPeer(
		peer,
		identity_ask, 
		id.privateKey,
	)
	// Awaiting the response
	let response = await responseRegistry.getInstance().checkResponse(comlink.muid)
	// Response management
	if (response[0]) {
		console.log("[PEER AUTHENTICATION] Received response")
		console.log(response[1].identity.toString("hex"))
		// Adding the property to the peer
		peer.identity = response[1].identity
	} else {
		console.log("[PEER AUTHENTICATION] No response received")
	}
	return peer
}