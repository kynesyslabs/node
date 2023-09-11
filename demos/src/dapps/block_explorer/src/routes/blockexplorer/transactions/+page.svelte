<script>
    import '$lib/global.css';
    export let data;
    import Fa from 'svelte-fa';
    import {faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
	import TransactionGrid from '../../../lib/components/blockexplorer/TransactionGrid.svelte';
</script>

<style>
    .title{
        text-align: center;
        margin-bottom: 64px;
    }
</style>

<h2 class="title">Transactions</h2>
<TransactionGrid transactions={data.transactions}/>