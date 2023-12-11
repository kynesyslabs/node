<script>
    import { selectedEditor } from "$lib/env";
    import BlockLayout from "./blockEditor/BlockLayout.svelte";
    import FlowLayout from "./flowEditor/FlowLayout.svelte";
</script>

{#if $selectedEditor == "block" || $selectedEditor == "auto"}
    <BlockLayout>
        <slot />
    </BlockLayout>
{:else if $selectedEditor == "flow"}
    <FlowLayout>
        <slot />
    </FlowLayout>
{/if}