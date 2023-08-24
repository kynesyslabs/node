import demos from '$lib/demos.js';
export async function load ({params})
{
    const rpc = "http://85.208.48.187:53550";
    demos.connect(rpc);
    let address = await demos.getAddressInfo("b7535851d5b9ff67d1eea37c48e3062ee62bdb3ffb2f01ee4cf5812f84055f5b");
    let transactions = Promise.all(address.native.tx_list.map(tx=>{
        console.log(tx);
        //return demos.getTxByHash(tx);
    })).then((txs)=>{
        console.log(txs);
    })
    console.log(transactions);
    return {
        address: address,
    }
}