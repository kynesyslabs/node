<script>
    import { SvelteFlowProvider } from '@xyflow/svelte';
    import Header from '$lib/components/Header.svelte';
</script>
<div class="container">
<Header/>
<SvelteFlowProvider>
    <slot></slot>
</SvelteFlowProvider>
</div>

<style>
    .container{
        display: flex;
        flex-direction: column;
        height: 100vh;
    }
</style>