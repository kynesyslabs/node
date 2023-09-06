import demos from '$lib/demos.js';
import { rpcaddress } from '$lib/env.js';

export async function load ({params})
{
    const rpc = rpcaddress;
    demos.connect(rpc);
    
    let txskeleton = demos.transactions.empty();
    return {
        skeleton: txskeleton,
    }
}