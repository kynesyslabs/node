import os from "node:os";
import { randomBytes } from "node:crypto";

const NUM_STRINGS = 1000;
const STRING_SIZE_BYTES = 100 * 1024;
const BATCH_SIZE = 25;
const SHUTDOWN_TIMEOUT_MS = 2000;

type BatchMessage = { type: "batch"; batchId: number; items: string[] };
type ShutdownMessage = { type: "shutdown" };
type BatchResult = { type: "batch-result"; batchId: number; hashes: string[] };

const numWorkers = Math.max(1, os.cpus().length - 1);
const workerUrl = new URL("./worker.ts", import.meta.url);

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

console.log(
    `Generating ${NUM_STRINGS} x ${STRING_SIZE_BYTES / 1024}KB random strings...`,
);
const tGenStart = Bun.nanoseconds();
const strings: string[] = new Array(NUM_STRINGS);
for (let i = 0; i < NUM_STRINGS; i++) {
    strings[i] = randomBytes(STRING_SIZE_BYTES / 2).toString("hex");
}
const genMs = (Bun.nanoseconds() - tGenStart) / 1e6;
console.log(`Generation: ${genMs.toFixed(2)}ms`);

const batches: string[][] = [];
for (let i = 0; i < strings.length; i += BATCH_SIZE) {
    batches.push(strings.slice(i, i + BATCH_SIZE));
}

console.log(
    `Dispatching ${batches.length} batches of ${BATCH_SIZE} across ${numWorkers} workers...`,
);

let nextBatch = 0;
let completed = 0;
const allHashes: string[][] = new Array(batches.length);

const tHashStart = Bun.nanoseconds();
await new Promise<void>((resolve) => {
    const dispatchTo = (worker: Worker) => {
        if (nextBatch >= batches.length) return;
        const batchId = nextBatch++;
        const msg: BatchMessage = {
            type: "batch",
            batchId,
            items: batches[batchId],
        };
        worker.postMessage(msg);
    };

    for (const w of workers) {
        w.addEventListener("message", (e: MessageEvent) => {
            const data = e.data as BatchResult;
            if (data?.type !== "batch-result") return;
            allHashes[data.batchId] = data.hashes;
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
const hashMs = (Bun.nanoseconds() - tHashStart) / 1e6;

const totalHashes = allHashes.reduce(
    (sum, batch) => sum + (batch?.length ?? 0),
    0,
);

console.log(`Hashing:    ${hashMs.toFixed(2)}ms`);
console.log(`Total:      ${(genMs + hashMs).toFixed(2)}ms`);
console.log(
    `Throughput: ${(NUM_STRINGS / (hashMs / 1000)).toFixed(0)} hashes/sec`,
);
console.log(`Verified:   ${totalHashes}/${NUM_STRINGS} hashes received`);

await shutdown();
