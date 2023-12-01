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
export const theme = writable("dark");
export const updateTheme = (th) => {
    theme.set(th);
    localStorage.setItem("theme", th);
    window.dispatchEvent(new Event("storage"));
}

//authentication
export const wallet = writable(demos.DemosWebAuth.getInstance());
export const updateWallet = () => {
    wallet.set(demos.DemosWebAuth.getInstance());
    //save new key to local storage
    const prvkey = demos.DemosWebAuth.getInstance()?.stringified_keypair?.privateKey;
    if(prvkey)
        localStorage.setItem("prvkey", demos.DemosWebAuth.getInstance().stringified_keypair.privateKey)
    else
        localStorage.removeItem("prvkey");
};

//helpers
TimeAgo.addLocale(en);
export const timeAgo = new TimeAgo('en-US');
export const trim_address = (str, length)=>{
    if (str.length <= length - 3 || str.length <= 20)
    return str;
    return str.substr(0, Math.ceil(length/2)) + '...' + str.substr(str.length-Math.floor(length/2), str.length);
}

//wallets
//export const MMSDK = new MetaMaskSDK({dappMetadata:{name:"Morph JS"}});
//MMSDK.init();
