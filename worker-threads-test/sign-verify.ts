import os from "node:os";
import { randomBytes } from "node:crypto";
import { ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption";

const NUM_STRINGS = 1000;
const STRING_SIZE_BYTES = 100 * 1024;
const BATCH_SIZE = 25;
const SHUTDOWN_TIMEOUT_MS = 2000;

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

const numWorkers = Math.max(1, os.cpus().length - 1);
const workerUrl = new URL("./sign-verify.worker.ts", import.meta.url);

console.log(`Spawning ${numWorkers} workers...`);
const workers = Array.from(
    { length: numWorkers },
    () => new Worker(workerUrl.href),
);

let shuttingDown = false;
async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down workers...");
    await Promise.all(
        workers.map(
            (w) =>
                new Promise<void>((resolve) => {
                    let settled = false;
                    const done = () => {
                        if (settled) return;
                        settled = true;
                        resolve();
                    };
                    w.addEventListener("close", done, { once: true });
                    try {
                        const msg: ShutdownMessage = { type: "shutdown" };
                        w.postMessage(msg);
                    } catch {
                        done();
                        return;
                    }
                    setTimeout(() => {
                        w.terminate();
                        done();
                    }, SHUTDOWN_TIMEOUT_MS).unref();
                }),
        ),
    );
    console.log("All workers shut down.");
}

process.on("SIGINT", async () => {
    console.log("\nReceived SIGINT.");
    await shutdown();
    process.exit(130);
});

console.log("Generating ed25519 identity...");
const tIdStart = Bun.nanoseconds();
await ucrypto.generateIdentity("ed25519");
const identity = await ucrypto.getIdentity("ed25519");
const pubKeyHex = uint8ArrayToHex(identity.publicKey as Uint8Array);
const idMs = (Bun.nanoseconds() - tIdStart) / 1e6;
console.log(`Identity:    ${idMs.toFixed(2)}ms (pubkey ${pubKeyHex.slice(0, 18)}…)`);

console.log(
    `Generating ${NUM_STRINGS} x ${STRING_SIZE_BYTES / 1024}KB random strings...`,
);
const tGenStart = Bun.nanoseconds();
const strings: string[] = new Array(NUM_STRINGS);
for (let i = 0; i < NUM_STRINGS; i++) {
    strings[i] = randomBytes(STRING_SIZE_BYTES / 2).toString("hex");
}
const genMs = (Bun.nanoseconds() - tGenStart) / 1e6;
console.log(`Generation:  ${genMs.toFixed(2)}ms`);

console.log(`Hashing ${NUM_STRINGS} strings (sha256)...`);
const tHashStart = Bun.nanoseconds();
const hashes: string[] = new Array(NUM_STRINGS);
for (let i = 0; i < NUM_STRINGS; i++) {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(strings[i]);
    hashes[i] = hasher.digest("hex");
}
const hashMs = (Bun.nanoseconds() - tHashStart) / 1e6;
console.log(`Hashing:     ${hashMs.toFixed(2)}ms`);

console.log(`Signing ${NUM_STRINGS} hashes (ed25519, main thread)...`);
const tSignStart = Bun.nanoseconds();
const sigs: string[] = new Array(NUM_STRINGS);
const encoder = new TextEncoder();
for (let i = 0; i < NUM_STRINGS; i++) {
    const signed = await ucrypto.sign("ed25519", encoder.encode(hashes[i]));
    sigs[i] = uint8ArrayToHex(signed.signature);
}
const signMs = (Bun.nanoseconds() - tSignStart) / 1e6;
console.log(`Signing:     ${signMs.toFixed(2)}ms`);

const items: VerifyItem[] = hashes.map((hashHex, i) => ({
    hashHex,
    sigHex: sigs[i],
}));
const batches: VerifyItem[][] = [];
for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE));
}

console.log(
    `Dispatching ${batches.length} batches of ${BATCH_SIZE} across ${numWorkers} workers...`,
);

let nextBatch = 0;
let completed = 0;
let totalVerified = 0;
let totalFailed = 0;

const tVerifyStart = Bun.nanoseconds();
await new Promise<void>((resolve) => {
    const dispatchTo = (worker: Worker) => {
        if (nextBatch >= batches.length) return;
        const batchId = nextBatch++;
        const msg: BatchMessage = {
            type: "batch",
            batchId,
            pubKeyHex,
            items: batches[batchId],
        };
        worker.postMessage(msg);
    };

    for (const w of workers) {
        w.addEventListener("message", (e: MessageEvent) => {
            const data = e.data as BatchResult;
            if (data?.type !== "batch-result") return;
            totalVerified += data.verified;
            totalFailed += data.failed;
            completed++;
            if (completed === batches.length) {
                resolve();
            } else {
                dispatchTo(w);
            }
        });
        dispatchTo(w);
    }
});
const verifyMs = (Bun.nanoseconds() - tVerifyStart) / 1e6;

const totalMs = idMs + genMs + hashMs + signMs + verifyMs;

console.log(`Verifying:   ${verifyMs.toFixed(2)}ms (${numWorkers} workers)`);
console.log(`Total:       ${totalMs.toFixed(2)}ms`);
console.log(
    `Sign rate:   ${(NUM_STRINGS / (signMs / 1000)).toFixed(0)} sigs/sec (main)`,
);
console.log(
    `Verify rate: ${(NUM_STRINGS / (verifyMs / 1000)).toFixed(0)} verifs/sec (parallel)`,
);
console.log(`Verified:    ${totalVerified}/${NUM_STRINGS} (${totalFailed} failed)`);

await shutdown();
