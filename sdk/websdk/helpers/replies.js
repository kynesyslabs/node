const replies = {

  registry: {},

  // INFO Insert a muid in the reply registry
  waitReply: function (muid) {
    if (!replies.registry[muid]) {
      replies.registry[muid] = null
      console.log('[DEMOS] Waiting for response for ' + muid)
      console.log(replies.registry)
    }
  },

  // INFO Check if a muid is in the registry
  needReply: function (muid) {
    if (replies.registry[muid] === undefined) {
      return false
    } else {
      return true
    }
  },

  // INFO Get a reply from a muid
  getReply: function (muid) {
    return replies.registry[muid]
  },

  // NOTE As this method returns a promise, we can use it to asynchronously await for a reply
  checkReply: async function (muid) {
    let timeout = 5000 // 5 seconds
    let reply = replies.getReply(muid)
    while (reply === null && timeout > 0) {
      await new Promise(resolve => setTimeout(resolve, 100))
      reply = replies.getReply(muid)
      timeout -= 100
    }
    return reply // null if timeout
  }
}

exports.replies = replies
