<script>
    import CodePreview from '$lib/components/CodePreview.svelte';
    import Combobox from '$lib/components/inputs/Combobox.svelte';
    import {budinoslide} from '$lib/transitions.js';
    import demos from '$lib/demos.js';
    import {rpcaddress} from '$lib/env.js';
    import PageTitle from '$lib/components/PageTitle.svelte';
    import CubeSpinning from "$lib/components/CubeSpinning.svelte"
    import JsonTable from '$lib/components/JsonTable.svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';

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
        {id:"GET",label:"GET", disabled:false},
        {id:"POST",label:"POST", disabled:true},
        {id:"PUT",label:"PUT", disabled:true},
        {id:"DELETE",label:"DELETE", disabled:true},   
    ]

    /** @typedef {"body" | "verification" | "headers"} TabId*/
    /** @type {{id: TabId, label:string}[]}*/
    const tabs = [
        {id:"body",label:"Body"},
        {id:"verification",label:"Verification Data"},
        {id:"headers",label:"Headers"},
    ]

    let method = "GET";

    /** @type {"request" | "sending" | "response"}*/
    let state = "request";

    let theresponse;

    $:console.log("theresponse", theresponse);

    /** @type TabId*/
    let selectedtab = "body";

    let selectedObject = null;
    $:if(theresponse)
    {
        if(selectedtab == "body")
            selectedObject = theresponse.result;
        else if(selectedtab == "verification")
            selectedObject = theresponse.attestations;
        else if(selectedtab == "headers")
            selectedObject = theresponse.raw.headers;
    }

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
        if(!url.includes("http://") && !url.includes("https://"))
            url = "https://"+url;
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

    function handleChangeHeaders(ev, headerIndex, keyindex)
    {
        headers[headerIndex][keyindex] = ev.target.value;
        if(headerIndex==headers.length-1)
        {
            headers.push(["",""])
        }
        //delete all empty headers but the last one
        let newheaders = [];
        headers.forEach((header)=>{
            if(header[0] !== "" || header[1] !== "")
                newheaders.push(header);
        })
        newheaders.push(["",""]);
        headers = newheaders;
    }

    async function sendRequest()
    {
        state = "sending";
        if(params[params.length-1][0] == ""||params[params.length-1][1] == "")
            params.pop();
        console.log("url", url, "params", params);
        let response = await demos.Web2Transactions(method, url, params, headers, 5);
        theresponse = JSON.parse(response);
        Object.keys(theresponse.attestations).forEach((key)=>{
            theresponse.attestations[key].identity.data= theresponse.attestations[key].identity.data.toString();
            theresponse.attestations[key].signature.data= theresponse.attestations[key].signature.data.toString();
        })
        state = "response";
    }

    let url="";
    let params = [
        ["", ""]
    ];

    let headers = [
        ["", ""]
    ]

    $:if(params[params.length-1][0] == "" && params[params.length-1][1] == "" && params.length>1 && params[params.length-2][0] == "" && params[params.length-2][1] == "")
    {
        params.pop();
    }
</script>

<div>
    <PageTitle>Web2 {state=="response"?"Response":"Request"}</PageTitle>
    {#if state == "request"} 
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
            <div style="padding-bottom:64px;" transition:budinoslide>
                <h4 class="subtitle">Headers</h4>
                <div class="params">
                    {#each headers as header, index}
                        <div class="paramcontainer">
                            <div class="indexcontainer">{index+1}</div>
                            <div class="inputscontainer">
                                <input class="smallinput" on:input={(ev)=>{handleChangeHeaders(ev, index, 0)}} value={header[0]} placeholder="Insert parameter key"/>
                                <input class="smallinput" on:input={(ev)=>{handleChangeHeaders(ev, index, 1)}} value={header[1]} placeholder="Insert parameter value"/>
                            </div>
                        </div>
                    {/each}
                </div>
            </div>
        {/if}
    {:else if state == "sending"}
        <CubeSpinning/>
    {:else if theresponse}
        <!-- response tx hash -->
        <div class="hash wrapword">
            {theresponse.hash}
            <CopyButton text={theresponse.hash}/>
        </div>
        <div>
            <!--<button>[Switch to table view]</button>-->

            <h4 class="subtitle">Received Request</h4>

            <div class="response">
                <div class="request-recap">
                    <div class="request-url-container">
                        {#if theresponse.raw.url.slice(0, 5)=="https"}
                            <div class="secure-badge tooltipleft">
                                <span class="tooltiptextleft">This request was sent over HTTPS</span>
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="16" height="16"><g id="padlock-square-1--combination-combo-lock-locked-padlock-secure-security-shield-keyhole"><path id="Union" fill="var(--success)" fill-rule="evenodd" d="M8 7a4 4 0 1 1 8 0v3H8V7Zm-2 3V7a6 6 0 1 1 12 0v3h3v13H3V10h3Zm5 8.5v-4h2v4h-2Z" clip-rule="evenodd"></path></g></svg>
                            </div>
                        {:else}
                            <div class="secure-badge">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="16" height="16"><g id="disabled-padlock"><path id="Subtract" fill="var(--error)" fill-rule="evenodd" d="m19.47 23-13-13H3l0 13 16.47 0ZM.34 1.754l-.047-.047L1.707.293l4.654 4.653A6.002 6.002 0 0 1 18 7v3h3l0 9.586 2.707 2.707-1.414 1.414-.516-.515.003-.003L.343 1.75l-.003.003ZM16 10h-4.586L8.02 6.605A4 4 0 0 1 16 7v3Z" clip-rule="evenodd"></path></g></svg>
                            </div>
                        {/if}
                        <div class="used-method">
                            {theresponse.raw.action}
                        </div>
                        <div class="request-url">
                            {theresponse.raw.url}
                        </div>
                    </div>
                </div>    
            </div>

            <h4 class="subtitle">Response</h4>

            <div class="tabs">
                {#each tabs as tab}
                    <button on:click={()=>{selectedtab=tab.id}} class={`secondary tab ${tab.id==selectedtab?"selected":""}`}>{tab.label}</button>
                {/each}
            </div>

            <div class="response">
                <div style="background:var(--background);">
                    <!--<CodePreview id="ciao" text={selectedtab=="body"?JSON.stringify(theresponse.result, null, "\t"):selectedtab=="verification"?JSON.stringify(theresponse.attestations,  null, "\t"):selectedtab=="headers"?JSON.stringify(theresponse.raw.headers,  null, "\t"):""}/>-->
                    {#if selectedObject}
                        <JsonTable data={selectedObject}/>
                    {/if}
                </div>
            </div>
        </div>
        <button class="primary" style="margin-left:auto;" on:click={()=>{
            state = "request";
            theresponse = null;
            url="";
            params = [
                ["", ""]
            ];
            headers = [
                ["", ""]
            ]
        }}>New request</button>
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
        margin-bottom: 48px;
    }
    .sendicon{
        transform: rotate(45deg);
    }
    .tabs {
		display: flex;
		align-items: center;
		margin-bottom: 16px;
        flex-wrap: wrap;
        gap: 16px;
	}
	.tab {
        padding: 8px 0;
		border: none;
		color: var(--color);
		font-size: 0.9rem;
		cursor: pointer;
        text-align: left;
		padding: 8px 16px;
        border: 1px solid var(--background3);
	}
	.tab.selected{
		background-color: var(--color);
        border: 1px solid var(--color);
		color: var(--background);
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
    .request-recap{
        display: flex;
        gap: 16px;
        align-items: center;
        border-bottom: 1px solid var(--background3);
    }
    .secure-badge{
        position: relative;
        top: 1px;
    }
    .used-method{
        font-weight: bold;
        opacity: .6;
    }
    .request-url-container{
        display: flex;
        padding: 12px 16px;
        background-color: var(--background2);
        border: 1px solid var(--background3);
        width: calc(100% - 32px);
        margin: 16px;
        gap: 16px;
    }
    .request-url{
        /*no wrap*/
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: block;
        width: calc(100%);
    }
    .hash{
        margin-top: -32px;
        margin-bottom: 48px;
    }
</style>