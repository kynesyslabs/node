import demos from '$lib/demos.js';
import { rpcaddress } from '$lib/env.js';

export async function load ({params})
{
    const rpc = rpcaddress;
    demos.connect(rpc);
    let transaction = await demos.getTxByHash("dd3fc542784875538efef89815672c693f8175f1007450b8e890c618650dd03e");
    return {
        transactions: [transaction],
    }
}