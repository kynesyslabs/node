import io from 'socket.io-client'
import { replies } from './replies.js'

const connections = {
  socket: null,
  connected: false,

  replies,

  // SECTION Connection and listeners
  connect: function (rpc_url) {
    connections.socket = io.connect(rpc_url, {
      extraHeaders: {
        'Access-Control-Allow-Origin': '*'
      }
    })
    console.log('[DEMOS] Connected to server')
    connections.connected = true
    // Listeners
    connections.socket.on('connect', function () {
      console.log('[DEMOS] Connected to server')
      connections.connected = true
    })
    connections.socket.on('disconnect', function () {
      console.log('[DEMOS] Disconnected from server')
      connections.connected = false
    })
    // NOTE Reply to comlink messages
    connections.socket.on('comlink_reply', function (reply) {
      if (!reply.chain.current.currentMessage.bundle.content.message) {
        console.log('[!] [DEMOS] Received a comlink_reply without a message!')
        return
      }
      const _muid = reply.muid
      console.log('[DEMOS] Received comlink_reply: ' + _muid)
      if (connections.replies.needReply(_muid)) {
        console.log('[DEMOS] Received an expected reply!')
        connections.registry[_muid] =
                    reply.chain.current.currentMessage.bundle.content.message
        // console.log(reply.chain.current.currentMessage.bundle.content.message)
      } else {
        console.log('[DEMOS] Received an unexpected reply!')
      }
    })

    // ANCHOR Catch-all (mainly for debug purposes)
    connections.socket.onAny((event, data) => {
      console.log(event)
      console.log(data)
    })
  }
}

exports.connections = connections
