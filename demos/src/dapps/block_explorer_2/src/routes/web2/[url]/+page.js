import demos from '$lib/demos.js';
export async function load ({params})
{
    //const rpc = "http://85.208.48.187:53550";
    //demos.connect(rpc);
    //quello vero
    //let transaction = await demos.getTxByHash(params.transaction);
    //console.log(transaction)
    //quello di prova
    //let block = await demos.getBlockByNumber(0);
    return {
        url: params.url,
    }
}