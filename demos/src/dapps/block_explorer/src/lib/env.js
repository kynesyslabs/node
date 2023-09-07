import { writable } from "svelte/store";
import demos from "$lib/demos.js";
export const rpcaddress = "https://rpc.demoscan.live";
export const wallet = writable(demos.DemosWebAuth.getInstance());
export const updateWallet = () => {
    wallet.set(demos.DemosWebAuth.getInstance());
};