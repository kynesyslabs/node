import demos from '$lib/demos.js';
export async function load ({params})
{
    const rpc = "http://85.208.48.187:53550";
    demos.connect(rpc);
    
    let txskeleton = demos.transactions.empty();
    return {
        skeleton: txskeleton,
    }
}