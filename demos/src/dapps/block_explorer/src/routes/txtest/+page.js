import demos from '$lib/demos.js';
import forge from 'node-forge';
export async function load ({params})
{
    const rpc = "http://85.208.48.187:53550";
    var ed25519 = forge.pki.ed25519;
    var keypair = ed25519.generateKeyPair();
    demos.connect(rpc);
    
    let txskeleton = demos.transactions.empty();

    //let txprep = await demos.transactions.prepare(txskeleton);
    //let txsigned = await demos.transactions.sign(txprep, keypair.privateKey);
    console.log(txskeleton);
    return {
        skeleton: txskeleton,
    }
}