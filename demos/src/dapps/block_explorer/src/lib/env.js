import { writable } from "svelte/store";
import demos from "$lib/demos.js";
import TimeAgo from 'javascript-time-ago';
import en from 'javascript-time-ago/locale/en'

//connection
export const rpcaddress = writable("https://rpc.demoscan.live");
export const updateRpcAddress = (address) => {
    rpcaddress.set(address);
}

//theme
export const theme = writable("auto");
export const updateTheme = (th) => {
    theme.set(th);
    localStorage.setItem("theme", th);
    window.dispatchEvent(new Event("storage"));
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
//export const MMSDK = new MetaMaskSDK({dappMetadata:{name:"Morph JS"}});
//MMSDK.init();
