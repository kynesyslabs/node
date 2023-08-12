import demos from '$lib/demos.js';
export async function load ({params})
{
    const rpc = "http://85.208.48.187:53550";
    demos.connect(rpc);
    let transaction = await demos.getTxByHash();
    return {
        transaction: transaction,
    }
}