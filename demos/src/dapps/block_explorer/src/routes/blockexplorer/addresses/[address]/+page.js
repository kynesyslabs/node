import demos from '$lib/demos.js';
import { rpcaddress } from '$lib/env.js';

export async function load ({params})
{
    const rpc = $rpcaddress;
    demos.connect(rpc);
    let address = await demos.getAddressInfo("b7535851d5b9ff67d1eea37c48e3062ee62bdb3ffb2f01ee4cf5812f84055f5b");
    let transaction = await demos.getTxByHash("dd3fc542784875538efef89815672c693f8175f1007450b8e890c618650dd03e");
    return {
        address: address,
        transactions: [transaction]
    }
}