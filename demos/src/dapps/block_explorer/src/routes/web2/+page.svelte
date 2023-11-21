<script>
    import CodePreview from '$lib/components/CodePreview.svelte';
    import Combobox from '$lib/components/inputs/Combobox.svelte';
    import {budinoslide} from '$lib/transitions.js';
    import demos from '$lib/demos.js';
    import {rpcaddress} from '$lib/env.js';
    import PageTitle from '$lib/components/PageTitle.svelte';
    import CubeSpinning from "$lib/components/CubeSpinning.svelte"

    demos.connect($rpcaddress);

    const code=`{
    "type": "page",
    "title": "Page",
    "content": [
        {
            "type": "text",
            "content": "This is a page"
        }
    ]
}`
    const requestType=[
        {id:"GET",label:"GET"},
        {id:"POST",label:"POST"},
        {id:"PUT",label:"PUT"},
        {id:"DELETE",label:"DELETE"},   
    ]
    const tabs = [
        {id:"body",label:"Body"},
        {id:"verification",label:"Verification Data"},
        {id:"headers",label:"Headers"},
    ]

    let method = "GET";

    let waiting = false;

    let theresponse;

    let selectedtab = "body";

    function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (err) {
        return false;
    }
    }

    function handleChangeUrl()
    {
        if(isValidUrl(url))
        {
            if(url.includes("?"))
            {
                let currentparams = [];
                let parampairs = url.split("?")[1].split("&")
                parampairs.forEach((pair)=>{
                    if(pair.includes("="))
                        currentparams.push(pair.split("="))
                    else
                        currentparams.push([pair, ""])
                })
                if(currentparams[currentparams.length-1][0] != "" || currentparams[currentparams.length-1][1] != "")
                {
                    currentparams.push(["", ""]);
                }
                params = currentparams;
            }
        }
    }

    function handleChangeParams(ev, paramindex, keyindex)
    {
        params[paramindex][keyindex] = ev.target.value;
        if(paramindex==params.length-1)
        {
            params.push(["",""])
        }
        let newurl = url.split("?")[0];
        if(params.length>0)
        {
            newurl+="?"
            params.forEach((param)=>{
                if(param[0] !== "" || param[1] !== "")
                newurl+=`${param[0]}=${param[1]}&`
            })
            newurl = newurl.slice(0, -1);
        }
        url = newurl;
    }

    async function sendRequest()
    {
        waiting = true;
        if(params[params.length-1][0] == ""||params[params.length-1][1] == "")
            params.pop();
        console.log("url", url, "params", params);
        let response = await demos.Web2Transactions(method, url, params, null, 5);
        theresponse = JSON.parse(response);
        waiting = false;
        //console.log("response", theresponse.attestations);
    }

    let url="";
    let params = [
        ["", ""]
    ];

    $:if(params[params.length-1][0] == "" && params[params.length-1][1] == "" && params.length>1 && params[params.length-2][0] == "" && params[params.length-2][1] == "")
    {
        params.pop();
    }
</script>

<div>
    <PageTitle>Web2 Request</PageTitle>
    <div style="margin-bottom: 64px;">
        <div class="inputcontainer">
            <Combobox value={method} onChange={(v)=>{method = v;}} options={requestType} style="height:100%;font-weight:bold;width:100%;min-height:45px"/>
            <input bind:value={url} on:input={handleChangeUrl} class="input" placeholder="Insert the URL here"/>
            <button class="secondary sendbutton" on:click={sendRequest}>Send</button>
        </div>
        {#if url}
        <div transition:budinoslide><p style="opacity:.6;margin:0;padding:8px">{url}</p></div>
        {/if}
    </div>
    {#if isValidUrl(url)}
        <div style="padding-bottom:64px;" transition:budinoslide>
            <h4 class="subtitle">Parameters</h4>
            <div class="params">
                {#each params as param, index}
                    <div class="paramcontainer">
                        <div class="indexcontainer">{index+1}</div>
                        <div class="inputscontainer">
                            <input class="smallinput" on:input={(ev)=>{handleChangeParams(ev, index, 0)}} value={param[0]} placeholder="Insert parameter key"/>
                            <input class="smallinput" on:input={(ev)=>{handleChangeParams(ev, index, 1)}} value={param[1]} placeholder="Insert parameter value"/>
                        </div>
                    </div>
                {/each}
            </div>
        </div>
    {/if}
    {#if waiting}
        <CubeSpinning/>
    {/if}
    {#if theresponse}
    <div>
        <h4 class="subtitle">Response</h4>
        <div class="response">
            <div class="tabs">
                {#each tabs as tab}
                    <button on:click={()=>{selectedtab=tab.id}} class={`secondary tab ${tab.id==selectedtab?"selected":""}`}>{tab.label}</button>
                {/each}
            </div>
            <div style="background:var(--background);">
                <CodePreview id="ciao" text={selectedtab=="body"?JSON.stringify(theresponse.result, null, "\t"):selectedtab=="verification"?JSON.stringify(theresponse.attestations,  null, "\t"):selectedtab=="headers"?JSON.stringify(theresponse.raw.headers,  null, "\t"):""}/>
            </div>
        </div>
    </div>
    {/if}
</div>

<style>
    .title{
        margin: 0;
    }
    .subtitle{
        margin-bottom: 16px;
    }
    .indexcontainer{
        background-color: var(--background2);
        border: 1px solid var(--background3);
        display: flex;
        align-items: center;
        justify-content: center;
        margin-right: 8px;
    }
    .paramcontainer{
        display: grid;
        grid-template-columns: 35px 1fr;
        margin-bottom: 32px;
    }
    .inputcontainer{
        display: grid;
        grid-template-columns: 150px 1fr auto;
        align-items: stretch;
    }
    .inputscontainer{
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        align-items: stretch;
    }
    .input{
        border-left: 0;
    }
    .method{
        border-right:none!important;
        height:100%;
        width:150px;
        font-weight:bold;
    }
    .sendbutton{
        border: 1px solid var(--background3);
        border-left: none;
        display: flex;
        align-items: center;
    }
    @media screen and (max-width: 768px) {
        .inputcontainer{
            grid-template-columns: 1fr;
            gap: 8px;
        }
        .input{
            border-left: 1px solid var(--background3);
        }
        .sendbutton{
            border: 1px solid var(--background3);
            width: auto;
            justify-content: end;
            margin-left: auto;
        }
    }
    .input{
        width: 100%;
    }
    .response{
        border: 1px solid var(--background3);
    }
    .sendicon{
        transform: rotate(45deg);
    }
    .tabs{
        display: flex;
        border-bottom: 1px solid var(--background3);
    }
    .tab{
        border: none;
        border-right: 1px solid var(--background3);
        font-weight: normal;
    }
    .selected{
        font-weight: bold;
        text-decoration: underline;
    }
    .fakeinput{
        border: 1px solid var(--background3);
        height: 52px;
        display: flex;
        align-items: center;
        padding: 0 var(--input-padding);
        font-weight: bold;
        width: 100%;
        border-bottom: 0;
    }
</style>