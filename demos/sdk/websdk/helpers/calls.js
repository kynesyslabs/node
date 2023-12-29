import forge from 'node-forge'
import { sha256 } from 'js-sha256'
import { connections } from './connections'
import { utils } from './utils'

const calls = {
  connections,

  nodeCall: async function (message, args = {}) {
    return await calls.call('nodeCall', message, args)
  },

  // INFO NodeCalls use the same structure
  call: async function (type, message, args = {}) {
    /* if (!demos.socket.connected) {
		console.log("[ERROR] We are disconnected")
		return
	} */
    const _muid = utils.generateMuid()
    const comlink = {
      muid: _muid,
      properties: {
        connection_string: null, // NOTE We don't have a connection_string as we are clients
        require_reply: true,
        is_reply: false
      },
      chain: {
        current: {
          currentMessage: null,
          currentMessageHash: null,
          previousHashes: [] // Keep track of the previous hashes to have full integrity
        },
        comlinkCurrentHash: null, // is the hashed version of .current
        comlinkCurrentHashSignature: null // is the signature of the hashed version of.current
      }
    }
    const transmission = {
      bundle: {
        content: {
          type: null,
          message: null,
          sender: null,
          receiver: null,
          timestamp: null,
          data: null,
          extra: null
        }
      },
      hash: null,
      signature: null
    }
    transmission.bundle.content.type = type
    transmission.bundle.content.message = message
    transmission.bundle.content.data = args
    comlink.chain.current.currentMessage = transmission

    // REVIEW Prior to sending the message, we hash and sign the comlink and the transmission objects

    // TODO Eliminate this: generating a random identity for the signature
    const seed = forge.random.getBytesSync(32)
    const keys = forge.pki.ed25519.generateKeyPair(seed)
    const privkey = keys.privateKey
    console.log(keys)
    // Signaling our identity
    comlink.chain.current.currentMessage.bundle.content.sender = keys.publicKey
    // NOTE Doing the cryptography for the transmission object
    const stringifiedTransmission = JSON.stringify(comlink.chain.current.currentMessage.bundle.content)
    const t_digestor = sha256.create()
    t_digestor.update(stringifiedTransmission)
    const t_hashed = t_digestor.hex()
    console.log(t_hashed + ' is the hashed version of comlink.chain.current.currentMessage.bundle.content')
    comlink.chain.current.currentMessage.bundle.hash = t_hashed
    comlink.chain.current.currentMessageHash = t_hashed
    // And signing it
    const t_signature = forge.pki.ed25519.sign({
      message: t_hashed,
      encoding: 'utf8',
      privateKey: privkey
    })
    console.log(t_signature.toString('hex') + ' is the signature of the hashed version of comlink.chain.current.currentMessage.bundle.content')
    comlink.chain.current.currentMessage.bundle.signature = t_signature

    // NOTE Also hashing the comlink current property
    const stringifiedMessage = JSON.stringify(comlink.chain.current)
    const digestor = sha256.create()
    digestor.update(stringifiedMessage)
    const hashed = digestor.hex()
    console.log(hashed + ' is the hashed version of comlink.chain.current')
    comlink.chain.comlinkCurrentHash = hashed
    // Signing the hash
    // console.log(keys.publicKey.toHex() + " is the public key of the signing key")
    // console.log(keys.privateKey.toHex() + " is the private key of the signing key")
    const signature = forge.pki.ed25519.sign({
      message: hashed,
      encoding: 'utf8',
      privateKey: privkey
    })
    console.log(signature.toString('hex') + ' is the signature of the hashed version of comlink.chain.current')
    comlink.chain.comlinkCurrentHashSignature = signature // FIXME TypeError in comlink.ts

    console.log(
      'Sending message ' +
			message +
			' to server with muid: ' +
			comlink.muid
    )
    // Registering the reply request
    connections.replies.waitReply(_muid)
    console.log(comlink)
    connections.socket.emit('comlink', comlink)
    // Waiting for a reply
    return await connections.replies.checkReply(_muid)
  }
}

exports.calls = calls
