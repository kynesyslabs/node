import { writable } from "svelte/store";
import demos from "$lib/demos.js";
import TimeAgo from 'javascript-time-ago';
import en from 'javascript-time-ago/locale/en'
import { MetaMaskSDK } from '@metamask/sdk';

//connection
export const rpcaddress = writable("https://rpc.demoscan.live");
export const updateRpcAddress = (address) => {
    rpcaddress.set(address);
}

//authentication
export const wallet = writable(demos.DemosWebAuth.getInstance());
export const updateWallet = () => {
    wallet.set(demos.DemosWebAuth.getInstance());
};

//helpers
TimeAgo.addLocale(en);
export const timeAgo = new TimeAgo('en-US');

//wallets
export const MMSDK = new MetaMaskSDK({dappMetadata:{name:"Morph JS"}});
MMSDK.init();
