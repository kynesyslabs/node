<script>
    /** @type {Object}*/
    export let data;
    let collapsed = false;
</script>

<div class="json-table">
    <div class="table-head">
        <div class="item-number">
            {Object.keys(data).length} Items
        </div>
        <button on:click={()=>{collapsed=!collapsed}} class="futuristic">{collapsed?"Show":"Hide"}</button>
    </div>
    {#if !collapsed}
        {#each Object.keys(data) as key}
            <div class="json-row card">
                <div class="json-key ellipsis">
                    {key}
                </div>
                <div>
                    {#if typeof data[key] === 'object' && data[key] !== null}
                        <svelte:self data={data[key]} />
                    {:else}
                        <div class="json-value">
                            {data[key]}
                        </div>
                    {/if}
                </div>
            </div>
        {/each}
    {/if}
</div>

<style>
    .table-head{
        display: grid;
        grid-template-columns: 1fr 1fr;
        background-color: var(--background2);
        gap: 16px;
        align-items: center;
        padding: 16px;
        border-bottom: 1px solid var(--background3);
    }
    .item-number{
        font-style: italic;
    }
    .json-row {
        display: grid;
        grid-template-columns: 100px 1fr;
        background-color: var(--background);
        margin: 16px;
        width: calc(100% - 32px);
        overflow: auto;
    }
    .json-key{
        font-weight: bold;
        background-color: var(--background2);
        padding: 16px;
        border-right: 1px solid var(--background3);
    }
    .json-value{
        overflow-wrap: anywhere;
        padding: 16px;
    }
    /* alternate background color */
    /*.json-row:nth-child(even) {
        background-color: var(--background2);
    }*/
</style>