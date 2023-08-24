<div class="grid-card">
    <div class="card-header">   
        <p class="card-header-label">Total of 1 transactions</p>
    </div>
        <div class="transactions-grid grid-header-row">
            <p class="grid-header-label">Hash</p>
            <p class="grid-header-label">Type</p>
            <p class="grid-header-label">Currency</p>
            <p class="grid-header-label">From</p>
            <p class="grid-header-label">To</p>
            <p class="grid-header-label">Amount</p>
        </div>
        <div class="transactions-grid">
            <!--{#each data.block.content.transactions as transaction}-->
                <a class="accessible grid-cell" href={`/blockexplorer/blocks/${data.transaction.hash}`}><p class="grid-cell">{data.transaction.hash}</p></a>
                <p class="grid-cell">{data.transaction.content.type}</p>
                <p class="grid-cell">{data.transaction.content.data.properties.name} ({data.transaction.content.data.properties.currency})</p>
                <p class="grid-cell">{data.transaction.content.from}</p>
                <p class="grid-cell">{data.transaction.content.to}</p>
                <p class="grid-cell">{data.transaction.content.amount}</p>
            <!--{/each}-->
        </div>
        <div class="card-footer">
            <div class="page-controller">
                <button class="page-controller-button">First</button>
                <button class="page-controller-button"><Fa icon={faChevronLeft}/></button>
                    <p class="page-controller-label">Page 1 of 1</p>
                <button class="page-controller-button"><Fa icon={faChevronRight}/></button>
                <button class="page-controller-button">Last</button>
            </div>
        </div>
</div>