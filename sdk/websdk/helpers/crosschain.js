import calls from './calls.js'

// INFO Crosschain support endpoints
const crosschain = {
  // INFO Executing a precompiled multichain operation
  execute: async function (multichain_operation) {
    let response = await calls.nodeCall('crosschain_operation', { multichain_operation })
    response = JSON.parse(response)
    return response
  }
}

exports.crosschain = crosschain
