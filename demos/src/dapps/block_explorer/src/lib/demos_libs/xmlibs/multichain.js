// TODO Export all in one place
/* INFO
 * General usage information
 *
 * Every chain has to be instantiated using the static create() method.
 * For example:
 * let ripple_chain = await XRPL.create("https://s.altnet.rippletest.net")
 * We can then use the chain object to interact with the network.
 * For example:
 * console.log(ripple_chain.provider)
 *
 * For transactions that need to be signed, we can use the
 * prepare methods to obtain a signed payload (transaction)
 * that we will send together with the XM transaction.
 * For example, to do a transfer:
 * 	let signed_transfer = await ripple_chain.prepareTransfer(address, amount)
 * Now we can include this into the signedPayloads array:
 *  let xm_transaction = demos.crosschain.transaction
 *  xm_transaction.signedPayloads.push(signed_transfer)
 * And we can proceed to build the rest of the request.
 *
*/

export { default as XRPL } from './chains/xrpl'
export { default as EVM } from './chains/evm'
