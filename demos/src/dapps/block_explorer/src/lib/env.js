import { writable } from "svelte/store";
import demos from "$lib/demos.js";
import TimeAgo from 'javascript-time-ago';
import en from 'javascript-time-ago/locale/en'

//connection
export const rpcaddress = "https://rpc.demoscan.live";

//authentication
export const wallet = writable(demos.DemosWebAuth.getInstance());
export const updateWallet = () => {
    wallet.set(demos.DemosWebAuth.getInstance());
};

//crosschain data
export const operationsdata = writable({});

//helpers
TimeAgo.addLocale(en);
export const timeAgo = new TimeAgo('en-US');