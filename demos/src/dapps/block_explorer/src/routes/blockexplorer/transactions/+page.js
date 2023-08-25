import demos from '$lib/demos.js';
export async function load ({params})
{
    const rpc = "http://85.208.48.187:53550";
    demos.connect(rpc);
    let transaction = await demos.getTxByHash("dd3fc542784875538efef89815672c693f8175f1007450b8e890c618650dd03e");
    return {
        transactions: [transaction],
    }
}