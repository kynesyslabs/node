<script>
    import axios from 'axios';
    import { debounce } from 'lodash';
    import { faCircleNotch } from "@fortawesome/free-solid-svg-icons";
    import Fa from "svelte-fa";
	import Combobox from '$lib/components/inputs/Combobox.svelte';
    import {object_equals} from '$lib/env.js';
    // 0x33eecbf908478c10614626a9d304bfe18b78dd73 example contract address

    /** @type {Object.<string, any>} task params values, NOT contract method params */
    export let params;
    export let onChange;

    //initial values
    const addressParam = params["address"];
    const methodParam = params["method"];
    const paramsParam = params["params"]?JSON.parse(params["params"]):{};


    //current values
    let currentaddress = addressParam;
    let currentmethod = methodParam;
    let currentmethodparams = paramsParam?paramsParam:{};
    /** @type {Object[]}*/
    let abi = params["abi"]?JSON.parse(params["abi"]):[];
    let currentParams;
    $: currentParams = {address: currentaddress, method: currentmethod, params: JSON.stringify(currentmethodparams), abi: JSON.stringify(abi)}

    $: if(!object_equals(currentParams, params)){
        console.log(currentParams, params);
        onChange(currentParams);
    }

    function ChangeCurrentParams(paramid, value)
    {
        console.log("change", paramid, value);
        currentmethodparams[paramid] = value;
    }

    /** @typedef {Array.<{name:string, type:string}>} evmFunctionInput*/

    /** @typedef {Object} evmFunction
     * @property {string} name
     * @property {"function"} type
     * @property {"pure" | "view" | "nonpayable" | "payable"} stateMutability
     * @property {boolean} constant
     * @property {boolean} payable
     * @property {evmFunctionInput} inputs
     * @property {evmFunctionInput} outputs
    */

    /** @type {evmFunction[]}*/ 
    let functionList = abi?abi.filter(item => item.type === "function"):[];
    /** @type {import("$lib/types").ComboboxOption[]}*/
    let options = [];
    /**@type {evmFunction}*/  
    let selectedFunction = functionList.length>0&&currentmethod?functionList.find(fun=>fun.name==currentmethod):null;
    /** @type {evmFunctionInput} THIS ARE THE PARAMETERS FOR THE CONTRACT METHOD, NOT THE TASK*/
    let methodparams = [];

    $: functionList = abi.filter(item => item.type === "function");
    $: options = functionList.map(item => ({id: item.name, label: item.name}));
    $: methodparams = selectedFunction ? selectedFunction.inputs : [];
    $: currentmethod = selectedFunction ? selectedFunction.name : methodParam;

    const debounced = debounce((value)=>{
        const endpoint = `https://api.etherscan.io/api?module=contract&action=getabi&address=${value}&apikey=ID28UGF53T31PW6YRS9TYA6MZ5Y18BVSPD`;
        axios.get(endpoint).then(response => {
            loading = false;
            if(response.data.status === "1")
            {
                abi = JSON.parse(response.data.result);
            }
        });
    }, 1000);

    function handleInputChange(ev) {
        if(ev.target.value == "")
        {
            loading = false;
            return;
        }
        loading = true;
        debounced(ev.target.value);
    }

    /** @type {boolean}*/
    let loading = false;
</script>

<div style="width:100%" class="container">
    <div>
        <label for="hash">Contract Address</label>
        <div class="inputcontainer">
            <input bind:value={currentaddress} class="smallinput" id="hash" on:input={handleInputChange}/>
            {#if loading}
            <Fa style="position: absolute;
            right: 18px;
            top: 18px;" icon={faCircleNotch} color="var(--color3)" spin></Fa>
            {/if}
        </div>
    </div>
    {#if abi.length > 0}
        <div>
            <label for="function">Method</label>
            <Combobox id="function" value={selectedFunction?selectedFunction.name:methodParam?methodParam:""} onChange={(newValue)=>{selectedFunction = functionList.find(o=>o.name == newValue)}} options={options} />
        </div>
        {#if selectedFunction}
        <div id="params">
            {#each methodparams as param}
                <div>
                    <label for={param.name}>{param.name}</label>
                    <input value={currentmethodparams[param.name]?currentmethodparams[param.name]:""} on:input={(ev)=>{ChangeCurrentParams(param.name, ev.target.value)}} class="smallinput" id={param.name}/>
                </div>
            {/each}
            </div>
        {/if}
    {/if}
</div>

<style>
    .container{
        display: flex;
        flex-direction: column;
        gap: 16px;
        margin-bottom: 16px;
    }
    .inputcontainer{
        position: relative;
    }
</style>