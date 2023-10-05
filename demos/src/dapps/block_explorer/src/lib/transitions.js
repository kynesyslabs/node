import { cubicInOut } from "svelte/easing";
import { slide } from "svelte/transition";

function toprightbudino (node, {duration = 350, easing = cubicInOut}) {
    return {
        duration,
        css: t => {
            const eased = easing(t);
            return `
                transform: scale(${0.9 + eased/10});
                opacity: ${eased};
                transform-origin:top right;
            );`;
        }
    };
}


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

function budinotraslato (node, {duration = 350, easing = cubicInOut}) {
    return {
        duration,
        css: t => {
            const eased = easing(t);
            return `
                transform: scale(${0.9 + eased/10}) translate(-50%, -50%);
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

function budinoslide(node, {duration = 350, easing = cubicInOut}) {
    const slideTrans = slide(node, duration, easing)
    return {
        duration: duration,
        css: t =>{
            const eased = easing(t);
            return `${slideTrans.css(eased)}
            opacity: ${eased};
            transform: scale(${0.9 + eased/10});
        `}
    };
}

export {megabudino, budinofade, toprightbudino, budinoslide, budinotraslato};