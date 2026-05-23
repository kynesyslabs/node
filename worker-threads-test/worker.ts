declare var self: Worker;

type JobMessage =
    | { type: "batch"; batchId: number; items: string[] }
    | { type: "shutdown" };

type JobResult = {
    type: "batch-result";
    batchId: number;
    hashes: string[];
};

self.onmessage = (event: MessageEvent<JobMessage>) => {
    const msg = event.data;

    if (msg.type === "shutdown") {
        process.exit(0);
    }

    if (msg.type === "batch") {
        const hashes = new Array<string>(msg.items.length);
        for (let i = 0; i < msg.items.length; i++) {
            const hasher = new Bun.CryptoHasher("sha256");
            hasher.update(msg.items[i]);
            hashes[i] = hasher.digest("hex");
        }
        const result: JobResult = {
            type: "batch-result",
            batchId: msg.batchId,
            hashes,
        };
        postMessage(result);
    }
};
