<script>
    import '$lib/global.css';
    export let data;
    import Fa from 'svelte-fa';
    import {faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
	import TransactionGrid from '../../../lib/components/blockexplorer/TransactionGrid.svelte';
</script>

<style>
    .container{
        padding: 16px;
    }
</style>

<div class="container">
    <TransactionGrid transactions={data.transactions}/>
</div>