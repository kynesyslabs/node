<script>
    import { SvelteFlowProvider } from '@xyflow/svelte';
    import Header from '$lib/components/Header.svelte';
	import Footer from '$lib/components/Footer.svelte';
</script>
<div class="container">
<Header/>
<SvelteFlowProvider>
    <slot></slot>
</SvelteFlowProvider>
<Footer/>
</div>

<style>
    .container{
        display: flex;
        flex-direction: column;
        height: 100vh;
    }
</style>