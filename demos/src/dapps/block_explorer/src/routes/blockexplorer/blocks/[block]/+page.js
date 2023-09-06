import demos from '$lib/demos.js';
import { rpcaddress } from '$lib/env.js';

export async function load ({params})
{
    const rpc = rpcaddress;
    demos.connect(rpc);
    //let pblock = await demos.getBlockByNumber(params.block);
    let block = await demos.getBlockByNumber(0);
    return {
        block: block,
        //pblock: pblock
    }
}