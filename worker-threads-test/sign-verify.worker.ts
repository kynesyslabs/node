declare var self: Worker;

const workerId = Math.random().toString(36).slice(2, 6);
console.log(`[worker ${workerId}] booted, importing demosdk encryption...`);

const t0 = Bun.nanoseconds();
const { ucrypto, hexToUint8Array } = await import(
    "@kynesyslabs/demosdk/encryption"
);
const importMs = (Bun.nanoseconds() - t0) / 1e6;
console.log(
    `[worker ${workerId}] demosdk imported in ${importMs.toFixed(1)}ms`,
);

type VerifyItem = { hashHex: string; sigHex: string };
type BatchMessage = {
    type: "batch";
    batchId: number;
    pubKeyHex: string;
    items: VerifyItem[];
};
type ShutdownMessage = { type: "shutdown" };
type BatchResult = {
    type: "batch-result";
    batchId: number;
    verified: number;
    failed: number;
};
type ErrorResult = {
    type: "worker-error";
    batchId?: number;
    message: string;
    stack?: string;
};

const postError = (err: unknown, batchId?: number) => {
    const e = err as Error;
    console.error(`[worker ${workerId}] error:`, e?.message ?? err);
    const payload: ErrorResult = {
        type: "worker-error",
        batchId,
        message: e?.message ?? String(err),
        stack: e?.stack,
    };
    try {
        postMessage(payload);
    } catch {}
};

process.on?.("uncaughtException", (err) => postError(err));
process.on?.("unhandledRejection", (err) => postError(err));

self.onmessage = async (
    event: MessageEvent<BatchMessage | ShutdownMessage>,
) => {
    const msg = event.data;

    if (msg.type === "shutdown") {
        console.log(`[worker ${workerId}] shutdown received`);
        process.exit(0);
    }

    if (msg.type === "batch") {
        console.log(
            `[worker ${workerId}] received batch ${msg.batchId} (${msg.items.length} items)`,
        );
        try {
            const publicKey = hexToUint8Array(msg.pubKeyHex);
            let verified = 0;
            let failed = 0;

            for (const item of msg.items) {
                const ok = await ucrypto.verify({
                    algorithm: "ed25519",
                    message: new TextEncoder().encode(item.hashHex),
                    publicKey,
                    signature: hexToUint8Array(item.sigHex),
                } as any);
                if (ok) verified++;
                else failed++;
            }

            const result: BatchResult = {
                type: "batch-result",
                batchId: msg.batchId,
                verified,
                failed,
            };
            console.log(
                `[worker ${workerId}] sending result for batch ${msg.batchId} (${verified}/${msg.items.length})`,
            );
            postMessage(result);
        } catch (err) {
            postError(err, msg.batchId);
        }
    }
};

postMessage({ type: "ready", workerId });
console.log(`[worker ${workerId}] handler registered, ready signal sent`);
