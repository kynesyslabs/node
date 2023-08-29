/* eslint-disable no-unused-vars */
import demos from '$lib/demos.js';
import * as forge from "node-forge"
import { sha256 } from "js-sha256"
import { goto } from '$app/navigation';


export async function load ({params})
{
    /*demos.connect(rpc);
    var lastBlockNumber;
    var lastBlockHash;
    var inspector;
    async function getLastBlockInfo(){
        demos.getLastBlockNumber().then((blockNumber) => {
            lastBlockNumber = JSON.parse(blockNumber).number;
        });
        demos.getLastBlockHash().then((blockHash) => {
            lastBlockHash = JSON.parse(blockHash).hash;
        });
        console.log( await demos.getPeerIdentity());
    }
    $: if(demos.connected){
        getLastBlockInfo();
    }
    async function inspectBlock(blockNumber)
    {
        var result;
        result = await demos.getBlockByNumber(blockNumber);
        inspector = result;
    }
    $: if(lastBlockNumber !== undefined){
        inspectBlock(lastBlockNumber);
    }
    $:console.log(inspector);*/
    // INFO Testing crypto capabilities
    var md = sha256.create();
    md.update('The quick brown fox jumps over the lazy dog');
    console.log(md.hex());
    console.log("[crypto capabilities ready]")
    // INFO Testing the rpc connection
    const rpc = "http://85.208.48.187:53550";
    let block;
    demos.connect(rpc);
    if(demos.connected){
        let blockNumber = JSON.parse(await demos.getLastBlockNumber());
        console.log(blockNumber)
        block = await demos.getBlockByNumber(blockNumber.number);
    }
    return {
        block: block
    }
}