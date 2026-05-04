declare var self: Worker;

import { ucrypto, hexToUint8Array } from "@kynesyslabs/demosdk/encryption";

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

self.onmessage = async (
    event: MessageEvent<BatchMessage | ShutdownMessage>,
) => {
    const msg = event.data;

    if (msg.type === "shutdown") {
        process.exit(0);
    }

    if (msg.type === "batch") {
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
        postMessage(result);
    }
};
