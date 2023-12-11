import { writable } from "svelte/store";
import demos from "$lib/demos.js";
import TimeAgo from 'javascript-time-ago';
import en from 'javascript-time-ago/locale/en'


//these global variables stored in local storage are loaded in the main layout.svelte! (can't use localStorage in server side code)

//connection
export const rpcaddress = writable("https://node2.demoscan.live");
export const updateRpcAddress = (address) => {
    rpcaddress.set(address);
}

//theme
export const theme = writable("dark");
/** @param {"auto" | "light" | "dark"} th*/
export const updateTheme = (th) => {
    theme.set(th);
    localStorage.setItem("theme", th);
    window.dispatchEvent(new Event("storage"));
}


//selected xM editor
export const selectedEditor = writable("auto")
/** @param {"auto" | "block" | "flow"} editor*/
export const updateSelectedEditor = (editor) => {
    selectedEditor.set(editor);
    localStorage.setItem("selectedEditor", editor);
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
export const normalize_timestamp = (timestamp) => {
    if(timestamp.length == 10)
        return blocks[i].content.timestamp = blocks[i].content.timestamp*1000;
    return timestamp;
}

//wallets
//export const MMSDK = new MetaMaskSDK({dappMetadata:{name:"Morph JS"}});
//MMSDK.init();
