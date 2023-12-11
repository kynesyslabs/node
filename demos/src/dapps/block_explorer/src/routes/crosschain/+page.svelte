<script>
    import { selectedEditor } from "$lib/env";
    import BlockEditor from "./blockEditor/BlockEditor.svelte";
    import FlowEditor from "./flowEditor/FlowEditor.svelte";
</script>

{#if $selectedEditor == "block" || $selectedEditor == "auto"}
    <BlockEditor />
{:else if $selectedEditor == "flow"}
    <FlowEditor />
{/if}