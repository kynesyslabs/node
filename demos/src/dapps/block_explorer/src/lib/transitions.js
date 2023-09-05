import { cubicInOut } from "svelte/easing";

function megabudino (node, {duration = 350, easing = cubicInOut}) {
    return {
        duration,
        css: t => {
            const eased = easing(t);
            return `
                transform: scale(${0.9 + eased/10});
                opacity: ${eased};
                transform-origin:center;
            );`;
        }
    };
}

function budinofade (node, {duration = 350, easing = cubicInOut}) {
    return {
        duration,
        css: t => {
            const eased = easing(t);
            return `
                opacity: ${eased};
            );`;
        }
    };
}

export {megabudino, budinofade};