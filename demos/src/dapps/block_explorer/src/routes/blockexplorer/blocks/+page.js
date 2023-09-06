import demos from '$lib/demos.js';
import { rpcaddress } from '$lib/env.js';

export async function load ({params})
{
    const rpc = rpcaddress;
    demos.connect(rpc);
    //quello vero
    //let block = await demos.getBlockByNumber(params.block);
    //qyello di prova
    let block = await demos.getBlockByNumber(0);
    return {
        block: block
    }
}