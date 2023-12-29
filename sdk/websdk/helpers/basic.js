import { calls } from './helpers/calls.js'

const call = calls.call
const nodeCall = calls.nodeCall

const basic = {
  // SECTION Predefined calls
  getLastBlockNumber: async function () {
    return await nodeCall('getLastBlockNumber')
  },
  getLastBlockHash: async function () {
    return await nodeCall('getLastBlockHash')
  },
  getBlockByNumber: async function (blockNumber) {
    let block = await nodeCall('getBlockByNumber', {
      blockNumber
    })
    block = JSON.parse(block)
    block.content = JSON.parse(block.content)
    console.log(typeof block)
    return block
  },
  getBlockByHash: async function (blockHash) {
    let block = await nodeCall('getBlockByHash', {
      blockHash
    })
    block = JSON.parse(block)
    block.content = JSON.parse(block.content)
    console.log(typeof block)
    return block
  },
  // TODO Test it with davide
  getTxByHash: async function (txHash = 'e25860ec6a7cccff0371091fed3a4c6839b1231ccec8cf2cb36eca3533af8f11') {
    // Defaulting to the genesis tx of course
    let tx = nodeCall('getTxByHash', {
      hash: txHash
    })
    tx = JSON.parse(tx)
    tx.content = JSON.parse(tx.content)
    console.log(typeof tx)
    return tx
  },

  // INFO Web2 Endpoints
  getWeb2Data: async function (url = 'https://apple.com/robots.txt') {
    console.log('[DEMOS] Requesting url: ' + url)
    return await call('web2Request', {
      action: 'getUrl',
      httpVerb: 'GET',
      url,
      headers: ''
    })
  },

  getPeerlist: async function () {
    return await nodeCall('getPeerlist')
  },
  getMempool: async function () {
    return await nodeCall('getMempool')
  },
  getPeerIdentity: async function () {
    return await nodeCall('getPeerIdentity')
  }
  // !SECTION Predefined calls
}

exports.basic = basic
