import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"
import { writeNpyFloat32Matrix } from "./npy"

type SemanticEntry = {
    uuid: string
    level: "L0" | "L1" | "L2" | "L3" | "L4"
    semantic_fingerprint?: {
        natural_language_descriptions?: string[]
        intent_vectors?: string[]
    }
    code_location?: {
        file_path?: string | null
        symbol_name?: string | null
        line_range?: [number, number] | null
    }
}

type EmbedProvider = {
    name: string
    model: string
    dim: number
    embedBatch(texts: string[]): Promise<number[][]>
}

function sha1(text: string) {
    return crypto.createHash("sha1").update(text).digest("hex")
}

function nowIso() {
    return new Date().toISOString()
}

function readJsonl(p: string) {
    const raw = fs.readFileSync(p, "utf8").trim()
    if (!raw) return []
    return raw.split("\n").map(l => JSON.parse(l)) as SemanticEntry[]
}

function getDuplicateUuids(entries: SemanticEntry[]) {
    const seen = new Set<string>()
    const duplicates = new Set<string>()

    for (const entry of entries) {
        if (seen.has(entry.uuid)) {
            duplicates.add(entry.uuid)
            continue
        }
        seen.add(entry.uuid)
    }

    return [...duplicates].sort()
}

function stringifyAtomText(e: SemanticEntry) {
    const descs = e.semantic_fingerprint?.natural_language_descriptions ?? []
    const cleaned = descs
        .map(s => String(s ?? "").trim())
        .filter(Boolean)
        .slice(0, 8)
    if (cleaned.length === 0) {
        return `${e.uuid}: (no descriptions)`
    }
    // Keep consistent formatting for stable embeddings.
    return cleaned.map(s => `- ${s}`).join("\n")
}

async function embedWithHttpEndpoint(args: {
    baseUrl: string
    apiKey?: string
    model: string
    texts: string[]
}) {
    // Provider-agnostic HTTP embedding endpoint (OpenAI-compatible shape).
    // Expected response: { data: [{ embedding: number[] }, ...] }
    const res = await fetch(args.baseUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(args.apiKey ? { Authorization: `Bearer ${args.apiKey}` } : {}),
        },
        body: JSON.stringify({
            model: args.model,
            input: args.texts,
        }),
    })

    if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`Embedding request failed: ${res.status} ${res.statusText}\n${text}`)
    }

    const json = (await res.json()) as any
    const data = json?.data
    if (!Array.isArray(data)) {
        throw new Error("Embedding response missing `data` array")
    }
    const embeddings = data.map((d: any) => d?.embedding)
    for (let embeddingIndex = 0; embeddingIndex < embeddings.length; embeddingIndex++) {
        const embedding = embeddings[embeddingIndex]
        if (!Array.isArray(embedding)) {
            throw new Error(`Embedding response data[${embeddingIndex}].embedding must be number[]`)
        }
        for (let valueIndex = 0; valueIndex < embedding.length; valueIndex++) {
            const value = embedding[valueIndex]
            if (typeof value !== "number" || !Number.isFinite(value)) {
                throw new Error(
                    `Embedding response data[${embeddingIndex}].embedding[${valueIndex}] must be a finite number`,
                )
            }
        }
    }
    return embeddings as number[][]
}

function requireEnv(name: string) {
    const v = process.env[name]
    if (!v) throw new Error(`Missing required env var: ${name}`)
    return v
}

async function makeProviderFromEnv(): Promise<EmbedProvider> {
    const provider = (process.env.EMBED_PROVIDER ?? "http").toLowerCase()
    const model = process.env.EMBED_MODEL ?? "text-embedding-3-small"

    // For now we implement a single generic HTTP provider. You can point it at:
    // - OpenAI embeddings endpoint
    // - Azure/OpenAI compatible endpoint
    // - Any service that matches `{ model, input } -> { data: [{ embedding }] }`
    if (provider !== "http") {
        throw new Error(`Unsupported EMBED_PROVIDER=${provider}. Supported: http`)
    }

    const endpoint = requireEnv("EMBED_HTTP_ENDPOINT")
    const apiKey = process.env.EMBED_HTTP_API_KEY

    // Determine dimension by probing with a single embedding.
    const probe = await embedWithHttpEndpoint({
        baseUrl: endpoint,
        apiKey,
        model,
        texts: ["probe"],
    })
    const dim = probe[0]?.length ?? 0
    if (!Number.isFinite(dim) || dim <= 0) {
        throw new Error("Could not determine embedding dimension from probe response")
    }

    return {
        name: "http",
        model,
        dim,
        embedBatch: async (texts: string[]) =>
            embedWithHttpEndpoint({ baseUrl: endpoint, apiKey, model, texts }),
    }
}

async function main() {
    const repoRoot = process.cwd()
    const indexPath = path.join(repoRoot, "repository-semantic-map", "semantic-index.jsonl")
    const outDir = path.join(repoRoot, "repository-semantic-map", "embeddings")
    fs.mkdirSync(outDir, { recursive: true })

    const entries = readJsonl(indexPath)
    if (entries.length === 0) {
        throw new Error(`No atoms found in ${indexPath}`)
    }
    const duplicateUuids = getDuplicateUuids(entries)
    if (duplicateUuids.length > 0) {
        throw new Error(`Duplicate UUIDs found in ${indexPath}: ${duplicateUuids.join(", ")}`)
    }

    const provider = await makeProviderFromEnv()

    const texts = entries.map(stringifyAtomText)
    const uuids = entries.map(e => e.uuid)

    // Cache identical texts to avoid redundant embedding calls.
    const cache = new Map<string, number[]>()
    const textHash = texts.map(t => sha1(t))

    const batchSize = Number(process.env.EMBED_BATCH_SIZE ?? "64")
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
        throw new Error("EMBED_BATCH_SIZE must be a positive integer")
    }

    const rows = entries.length
    const cols = provider.dim
    const matrix = new Float32Array(rows * cols)

    let embedded = 0
    for (let i = 0; i < rows; i += batchSize) {
        const sliceTexts: string[] = []
        const sliceRowIndexes: number[] = []

        for (let j = i; j < Math.min(rows, i + batchSize); j++) {
            const h = textHash[j]
            const cached = cache.get(h)
            if (cached) {
                writeRow(matrix, j, cached)
                embedded++
                continue
            }
            sliceTexts.push(texts[j])
            sliceRowIndexes.push(j)
        }

        if (sliceTexts.length > 0) {
            const vecs = await provider.embedBatch(sliceTexts)
            if (vecs.length !== sliceTexts.length) {
                throw new Error(`Provider returned ${vecs.length} embeddings for ${sliceTexts.length} texts`)
            }
            for (let k = 0; k < vecs.length; k++) {
                const rowIndex = sliceRowIndexes[k]
                const vec = vecs[k]
                if (!Array.isArray(vec) || vec.length !== cols) {
                    throw new Error(`Embedding dim mismatch at row ${rowIndex}: got ${vec?.length}, expected ${cols}`)
                }
                cache.set(textHash[rowIndex], vec)
                writeRow(matrix, rowIndex, vec)
                embedded++
            }
        }

        if ((i / batchSize) % 10 === 0) {
            // Minimal progress signal for long runs.
            // eslint-disable-next-line no-console
            console.log(`[embed] ${embedded}/${rows} rows embedded`)
        }
    }

    const npyPath = path.join(outDir, "semantic-fingerprints.npy")
    writeNpyFloat32Matrix({ path: npyPath, rows, cols, data: matrix })

    const mappingPath = path.join(outDir, "uuid-mapping.json")
    fs.writeFileSync(
        mappingPath,
        JSON.stringify(
            {
                generated_at: nowIso(),
                provider: { name: provider.name, model: provider.model, dim: provider.dim },
                rows,
                cols,
                uuids,
            },
            null,
            2,
        ) + "\n",
        "utf8",
    )

    const metaPath = path.join(outDir, "meta.json")
    fs.writeFileSync(
        metaPath,
        JSON.stringify(
            {
                generated_at: nowIso(),
                index_path: "repository-semantic-map/semantic-index.jsonl",
                npy_path: "repository-semantic-map/embeddings/semantic-fingerprints.npy",
                mapping_path: "repository-semantic-map/embeddings/uuid-mapping.json",
                provider: { name: provider.name, model: provider.model, dim: provider.dim },
                notes: {
                    text_source: "semantic_fingerprint.natural_language_descriptions (joined)",
                    cache: "sha1(text) in-memory cache per run",
                },
            },
            null,
            2,
        ) + "\n",
        "utf8",
    )
}

function writeRow(matrix: Float32Array, rowIndex: number, vec: number[]) {
    const cols = vec.length
    const base = rowIndex * cols
    for (let i = 0; i < cols; i++) matrix[base + i] = vec[i]
}

if (import.meta.main) {
    main().catch(err => {
        // eslint-disable-next-line no-console
        console.error(err)
        process.exit(1)
    })
}
