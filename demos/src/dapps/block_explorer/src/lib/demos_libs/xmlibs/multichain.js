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
*/

export { default as XRPL } from './chains/xrpl'
export { default as EVM } from './chains/evm'

