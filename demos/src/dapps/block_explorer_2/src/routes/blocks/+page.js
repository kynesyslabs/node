import demos from '$lib/demos.js';
export async function load ({params})
{
    const rpc = "http://85.208.48.187:53550";
    demos.connect(rpc);
    //quello vero
    //let block = await demos.getBlockByNumber(params.block);
    //qyello di prova
    let block = await demos.getBlockByNumber(0);
    return {
        block: block
    }
}