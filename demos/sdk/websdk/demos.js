/* INFO

This library contains all the functions that are used to interact with the demos blockchain.

 * IMPORTANT: This library is incomplete and is not meant to be used in production.

 * NOTE: for convenience, you are strongly encouraged to use function_name instead of calling the
 *    corresponding function directly, but you are allowed to do both.

 * To initialize a connection to the demos blockchain, you will need to call connect(rpc_url) first.

 * Besides that, nodeCall is the primary function that you will want to use. 
 *    It manages a secure communication with the node and wait for a response or a timeout. It returns a promise.

*/

/* NOTE Libraries Required
 - https://cdn.jsdelivr.net/npm/node-forge@1.3.1/lib/index.min.js
 - https://cdn.socket.io/4.6.0/socket.io.min.js
*/

/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */

/* NOTE Important!
    Due to the modular nature of this library, objects such as connections.replies MUST be
    used JUST as instances of the parent class. If you import replies by its own, you will
    generate two separate objects with all the problems of the case.
*/

// NOTE Including all in a class
import { calls } from "./helpers/calls.js"
import { basic } from "./helpers/basic.js"
import { skeletons } from "./helpers/skeletons.js"

let demos = {
    skeletons: skeletons,
    call: calls.call, // Contains call.connections and call.replies too
    nodeCall: calls.nodeCall,
    basic: basic,
    crosschain: crosschain,
    transactions: transactions,
}

async function sleep(time) {
    return new Promise(resolve => setTimeout(resolve, time))
}

// Creating a demos class
//let demos = new Demos()
export default demos