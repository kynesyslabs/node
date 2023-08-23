import demos from '$lib/demos.js';
export async function load ({params})
{
    const rpc = "http://85.208.48.187:53550";
    demos.connect(rpc);
    //let pblock = await demos.getBlockByNumber(params.block);
    let block = await demos.getBlockByNumber(0);
    return {
        block: block,
        //pblock: pblock
    }
}