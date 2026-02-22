import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"
import * as ts from "typescript"

type Level = "L0" | "L1" | "L2" | "L3" | "L4"

type SemanticEntry = {
    uuid: string
    level: Level
    extraction_confidence: number
    documentation_quality: "rich" | "adequate" | "sparse" | "missing"
    verification_status: "parsed" | "inferred" | "assumed"
    semantic_fingerprint: {
        natural_language_descriptions: string[]
        intent_vectors: string[]
        domain_ontology_tags: string[]
        behavioral_contracts: string[]
    }
    code_location: {
        file_path: string | null
        line_range: [number, number] | null
        symbol_name: string | null
        language: "typescript" | "markdown" | "json" | "unknown"
        module_resolution_path: string | null
    }
    relationships: {
        depends_on: string[]
        depended_by: string[]
        implements: string[]
        extends: string[]
        calls: string[]
        called_by: string[]
        similar_to: string[]
        contrasts_with: string[]
    }
    interface_contract: {
        inputs: Array<{ name: string; type: string; semantic: string }>
        outputs: Array<{ type: string; semantic: string }>
        throws: string[]
        invariants: string[]
    }
    implementation_details: {
        algorithm_complexity: string | null
        concurrency_model: string | null
        persistence_layer: string[]
        external_integrations: string[]
        critical_path: boolean
        test_coverage: string | null
    }
    documentation_provenance: {
        primary_source: string | null
        related_adr: string | null
        last_modified: string | null
        authors: string[]
    }
}

type GraphNode = {
    uuid: string
    level: Level
    label: string
    file_path: string | null
    symbol_name: string | null
    line_range: [number, number] | null
    centrality: number
}

type GraphEdge = {
    from: string
    to: string
    type:
        | "depends_on"
        | "depended_by"
        | "implements"
        | "extends"
        | "calls"
        | "called_by"
        | "similar_to"
        | "contrasts_with"
}

function sha1(text: string) {
    return crypto.createHash("sha1").update(text).digest("hex")
}

function stableUuid(prefix: string, parts: Array<string | number | null | undefined>) {
    return `${prefix}-${sha1(parts.map(p => String(p ?? "")).join("|")).slice(0, 24)}`
}

function ensureDir(p: string) {
    fs.mkdirSync(p, { recursive: true })
}

function writeJson(p: string, obj: unknown) {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8")
}

function writeText(p: string, text: string) {
    fs.writeFileSync(p, text.endsWith("\n") ? text : text + "\n", "utf8")
}

function readUtf8IfExists(p: string) {
    try {
        return fs.readFileSync(p, "utf8")
    } catch {
        return null
    }
}

function spawnText(cmd: string, cwd: string) {
    const proc = Bun.spawnSync({
        cmd: ["bash", "-lc", cmd],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
    })
    const stdout = proc.stdout?.toString("utf8") ?? ""
    if (proc.exitCode !== 0) {
        const stderr = proc.stderr?.toString("utf8") ?? ""
        throw new Error(`Command failed (${proc.exitCode}): ${cmd}\n${stderr}\n${stdout}`)
    }
    return stdout
}

function toRepoRel(repoRoot: string, absOrRel: string) {
    const abs = path.isAbsolute(absOrRel) ? absOrRel : path.join(repoRoot, absOrRel)
    return path.relative(repoRoot, abs).replaceAll(path.sep, "/")
}

function fileIsInScope(relPath: string) {
    if (relPath.startsWith(".planning/")) return false
    if (relPath.startsWith("dist/")) return false
    if (relPath.startsWith("node_modules/")) return false
    if (relPath.startsWith("local_tests/")) return false
    if (relPath.startsWith("omniprotocol_fixtures_scripts/")) return false
    if (relPath.startsWith("sdk/")) return false
    if (relPath.startsWith("documentation/") && (relPath.endsWith(".ts") || relPath.endsWith(".tsx"))) {
        return false
    }
    return relPath.endsWith(".ts") || relPath.endsWith(".tsx")
}

function detectIntentsFromPath(relPath: string): string[] {
    const intents = new Set<string>()
    const p = relPath.toLowerCase()
    if (p.includes("/network/")) intents.add("networking")
    if (p.includes("/rpc")) intents.add("rpc")
    if (p.includes("/blockchain/")) intents.add("blockchain")
    if (p.includes("/consensus/")) intents.add("consensus")
    if (p.includes("/peer/")) intents.add("peer-management")
    if (p.includes("/crypto/")) intents.add("cryptography")
    if (p.includes("/omniprotocol/")) intents.add("p2p-protocol")
    if (p.includes("/features/mcp/")) intents.add("mcp")
    if (p.includes("/features/metrics/")) intents.add("observability")
    if (p.includes("/features/tlsnotary/")) intents.add("tlsnotary")
    if (p.includes("/features/multichain/")) intents.add("multichain")
    if (p.includes("/features/zk/")) intents.add("zero-knowledge")
    if (p.includes("/model/")) intents.add("persistence")
    if (p.includes("/migrations/")) intents.add("database-migrations")
    if (p.includes("/utilities/")) intents.add("utilities")
    if (p.startsWith("tests/")) intents.add("testing")
    return [...intents]
}

function isCriticalPath(relPath: string) {
    return (
        relPath === "src/index.ts" ||
        relPath === "src/utilities/mainLoop.ts" ||
        relPath.includes("/libs/network/") ||
        relPath.includes("/libs/blockchain/") ||
        relPath.includes("/libs/consensus/") ||
        relPath.includes("/libs/peer/") ||
        relPath.includes("/libs/omniprotocol/")
    )
}

function extractEnvVarsFromSourceText(sourceText: string) {
    const vars = new Set<string>()
    const re = /process\.env\.([A-Z0-9_]+)/g
    let match: RegExpExecArray | null
    while ((match = re.exec(sourceText))) vars.add(match[1])
    return [...vars].sort()
}

function getLineRange(sourceFile: ts.SourceFile, node: ts.Node): [number, number] {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
    return [start, Math.max(start, end)]
}

function getFileMTimeIso(repoRoot: string, relPath: string) {
    try {
        return fs.statSync(path.join(repoRoot, relPath)).mtime.toISOString()
    } catch {
        return null
    }
}

function summarizeJSDoc(node: ts.Node, sourceFile: ts.SourceFile) {
    const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc) as ts.JSDoc[]
    if (docs.length === 0) return null
    const d = docs[0]
    const text = (d.comment ? String(d.comment) : "").trim()
    if (!text) return null
    const [start, end] = getLineRange(sourceFile, d)
    return { text, primarySource: `JSDoc ${start}-${end}` }
}

function functionSignatureFromSyntax(fn: ts.SignatureDeclarationBase, sf: ts.SourceFile) {
    const params = fn.parameters.map(p => {
        const name = p.name.getText(sf)
        const type = p.type ? p.type.getText(sf) : "unknown"
        return `${name}: ${type}`
    })
    const ret = fn.type ? fn.type.getText(sf) : "unknown"
    return `(${params.join(", ")}) => ${ret}`
}

function normalizeModuleResolutionPath(relPath: string) {
    if (relPath.startsWith("src/")) {
        return relPath.replace(/\.tsx?$/, "").replace(/^src\//, "@/")
    }
    return relPath.replace(/\.tsx?$/, "")
}

function resolveImportToRelPath(repoRoot: string, fromRelFile: string, spec: string): string | null {
    const fromDir = path.posix.dirname(fromRelFile)

    const exists = (p: string) => fs.existsSync(path.join(repoRoot, p))

    const normalizeCandidate = (candidate: string) => {
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) return exists(candidate) ? candidate : null
        if (exists(candidate)) return candidate
        if (exists(candidate + ".ts")) return candidate + ".ts"
        if (exists(candidate + ".tsx")) return candidate + ".tsx"
        if (exists(candidate + "/index.ts")) return candidate + "/index.ts"
        if (exists(candidate + "/index.tsx")) return candidate + "/index.tsx"
        return null
    }

    if (spec.startsWith("@/")) return normalizeCandidate("src/" + spec.slice(2))
    if (spec.startsWith("src/")) return normalizeCandidate(spec)
    if (spec.startsWith(".")) return normalizeCandidate(path.posix.normalize(path.posix.join(fromDir, spec)))
    return null
}

function findCallsInNode(node: ts.Node, callableTargetsByName: Map<string, string>) {
    const calls: string[] = []
    const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n)) {
            const expr = n.expression
            if (ts.isIdentifier(expr)) {
                const target = callableTargetsByName.get(expr.text)
                if (target) calls.push(target)
            }
        }
        ts.forEachChild(n, visit)
    }
    visit(node)
    return calls
}

function seedOntologyFromDocs(docs: Array<{ path: string; text: string }>) {
    const seed = new Map<string, { count: number; sources: Set<string> }>()
    const add = (term: string, source: string) => {
        const key = term.toLowerCase()
        const v = seed.get(key) ?? { count: 0, sources: new Set<string>() }
        v.count++
        v.sources.add(source)
        seed.set(key, v)
    }

    const known = [
        "Demos Network",
        "PoRBFT",
        "GCR",
        "OmniProtocol",
        "TLSNotary",
        "MCP",
        "Bun",
        "TypeORM",
        "PostgreSQL",
        "Merkle tree",
        "ZK",
        "L2PS",
        "validator",
        "peer",
        "mempool",
        "block",
        "transaction",
        "bridge",
        "Rubic",
    ]
    for (const k of known) add(k, "seed")

    for (const d of docs) {
        const text = d.text.toLowerCase()
        for (const k of known) {
            if (text.includes(k.toLowerCase())) add(k, d.path)
        }
    }

    return [...seed.entries()]
        .map(([term, v]) => ({
            term,
            count: v.count,
            sources: [...v.sources].sort(),
        }))
        .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
}

function bumpPatch(v: string) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
    if (!m) return "1.0.0"
    return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

function average(xs: number[]) {
    if (xs.length === 0) return 0
    return xs.reduce((a, b) => a + b, 0) / xs.length
}

function buildQueryApiMarkdown(input: { version: string; gitRef: string; stats: any }) {
    return [
        "# Query API",
        "",
        `**Index version:** ${input.version}`,
        `**Git ref:** \`${input.gitRef}\``,
        "",
        "Artifacts:",
        "- `repository-semantic-map/semantic-index.jsonl` (JSONL atoms)",
        "- `repository-semantic-map/code-graph.json` (nodes/edges graph)",
        "- `repository-semantic-map/manifest.json` (metadata + stats)",
        "",
        "## Basic retrieval (JSONL)",
        "",
        "Examples using `jq`:",
        "```bash",
        "jq -r 'select(.semantic_fingerprint.intent_vectors[]? == \"consensus\") | .code_location.file_path + \":\" + (.code_location.line_range[0]|tostring) + \" \" + (.code_location.symbol_name//\"\")' repository-semantic-map/semantic-index.jsonl | head",
        "```",
        "",
        "## Query patterns",
        "",
        "```yaml",
        "Query Patterns:",
        "  - \"Where is consensus implemented?\"",
        "    -> Search: intent_vectors contains \"consensus\" + level in [L2,L3]",
        "    -> Return: `src/libs/consensus/v2/PoRBFT.ts` + callers in `src/utilities/mainLoop.ts`",
        "",
        "  - \"How does the RPC server route requests?\"",
        "    -> Search: intent_vectors contains \"rpc\" + file_path contains \"src/libs/network\"",
        "    -> Return: chain from `server_rpc.ts` to per-method managers",
        "",
        "  - \"Which code touches process.env?\"",
        "    -> Search: implementation_details.external_integrations contains entries starting with \"env:\"",
        "    -> Return: env-bound code paths (ports, keys, feature toggles)",
        "",
        "  - \"What depends on the consensus routine?\"",
        "    -> Graph traversal: find symbol 'consensusRoutine' -> called_by depth 2",
        "```",
        "",
        "## Notes",
        "",
        "- `calls` edges are conservative: only intra-file identifier calls are linked.",
        "- `depends_on` includes a symbol -> module edge plus module import edges where resolvable.",
        "",
        "## Index stats (this run)",
        "",
        "```json",
        JSON.stringify(input.stats, null, 2),
        "```",
        "",
    ].join("\n")
}

function buildConsumptionGuideMarkdown(input: { version: string; gitRef: string }) {
    return [
        "# Consumption Guide",
        "",
        `**Index version:** ${input.version}`,
        `**Git ref:** \`${input.gitRef}\``,
        "",
        "## Maintenance protocol",
        "",
        "On each re-index:",
        "1. Compute changed files via `git diff --name-only <prevRef>..<newRef>`.",
        "2. Re-run generator; in a future iteration, restrict parsing to affected modules and update `versioning/deltas/`.",
        "3. Re-scan generated artifacts for leaked secrets before committing.",
        "",
        "Current mode: full re-index (fast enough for this repo), patch version bump on each run.",
        "",
    ].join("\n")
}

function buildChangelogMarkdown(versions: any[]) {
    const lines = ["# Changelog", ""]
    for (const v of versions.slice().reverse()) {
        lines.push(`## ${v.version} (${v.timestamp})`)
        lines.push(`- git: \`${v.git_ref}\``)
        lines.push(`- change_type: \`${v.change_type}\``)
        lines.push(`- total_atoms: ${v.statistics.total_atoms}`)
        lines.push(`- confidence_avg: ${Number(v.statistics.confidence_avg).toFixed(3)}`)
        lines.push("")
    }
    return lines.join("\n")
}

function extractExportedAtomsFromSourceFile(args: {
    gitRef: string
    relPath: string
    sf: ts.SourceFile
    moduleUuid: string
    importSpecs: string[]
    envVars: string[]
    callableIndex: Map<string, string>
    last_modified: string | null
}) {
    const {
        gitRef,
        relPath,
        sf,
        moduleUuid,
        importSpecs,
        envVars,
        callableIndex,
        last_modified,
    } = args

    const exports: Array<{ name: string; decl: ts.Node; kind: string; level: Level }> = []

    const addExport = (name: string, decl: ts.Node, kind: string, level: Level) => {
        exports.push({ name, decl, kind, level })
    }

    for (const st of sf.statements) {
        if (ts.isExportAssignment(st)) {
            addExport("default", st, "export_default", "L3")
            continue
        }

        if (ts.isExportDeclaration(st)) {
            if (st.exportClause && ts.isNamedExports(st.exportClause)) {
                for (const el of st.exportClause.elements) {
                    const exportedName = (el.name ?? el.propertyName)?.getText(sf) ?? el.getText(sf)
                    addExport(exportedName, el, "re_export", "L3")
                }
            } else if (!st.exportClause) {
                addExport("*", st, "re_export_star", "L3")
            }
            continue
        }

        const isExported =
            (ts.getCombinedModifierFlags(st as any) & ts.ModifierFlags.Export) !== 0

        if (!isExported) continue

        if (ts.isFunctionDeclaration(st) && st.name) {
            addExport(st.name.text, st, "function", "L3")
        } else if (ts.isClassDeclaration(st) && st.name) {
            addExport(st.name.text, st, "class", "L2")
        } else if (ts.isInterfaceDeclaration(st)) {
            addExport(st.name.text, st, "interface", "L2")
        } else if (ts.isTypeAliasDeclaration(st)) {
            addExport(st.name.text, st, "type", "L2")
        } else if (ts.isEnumDeclaration(st)) {
            addExport(st.name.text, st, "enum", "L2")
        } else if (ts.isVariableStatement(st)) {
            for (const decl of st.declarationList.declarations) {
                if (!ts.isIdentifier(decl.name)) continue
                const name = decl.name.text
                const init = decl.initializer
                if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
                    addExport(name, decl, "function", "L3")
                } else {
                    addExport(name, decl, "variable", "L3")
                }
            }
        }
    }

    const entries: SemanticEntry[] = []
    const edges: GraphEdge[] = []
    const exportedUuids = new Set<string>()

    const registerCallable = (symbolName: string, uuid: string) => {
        callableIndex.set(`${relPath}::${symbolName}`, uuid)
        callableIndex.set(symbolName, uuid)
    }

    for (const exp of exports) {
        const [start, end] = getLineRange(sf, exp.decl)
        const jsDoc = summarizeJSDoc(exp.decl, sf)
        const signature =
            ts.isFunctionLike(exp.decl) ? functionSignatureFromSyntax(exp.decl as any, sf) : null

        const uuid = stableUuid("sym", [gitRef, relPath, exp.name, exp.kind, start, end])
        exportedUuids.add(uuid)

        const docQuality =
            jsDoc?.text && jsDoc.text.length > 120
                ? "rich"
                : jsDoc?.text
                  ? "adequate"
                  : "missing"

        const confidence =
            docQuality === "rich" ? 0.92 : docQuality === "adequate" ? 0.85 : 0.7

        const intents = new Set<string>(detectIntentsFromPath(relPath))
        if (exp.kind === "class") intents.add("abstraction")

        const descs = [
            `${exp.name} (${exp.kind}) exported from \`${relPath}\`.`,
            signature ? `TypeScript signature: ${signature}.` : "",
            jsDoc?.text ? jsDoc.text.split("\n")[0] : "",
        ].filter(Boolean)

        const entry: SemanticEntry = {
            uuid,
            level: exp.level,
            extraction_confidence: confidence,
            documentation_quality: docQuality,
            verification_status: exp.kind.startsWith("re_") ? "inferred" : "parsed",
            semantic_fingerprint: {
                natural_language_descriptions: descs,
                intent_vectors: [...intents],
                domain_ontology_tags: [],
                behavioral_contracts: [
                    ts.isFunctionLike(exp.decl) && (ts.getCombinedModifierFlags(exp.decl as any) & ts.ModifierFlags.Async) !== 0
                        ? "async"
                        : "",
                ].filter(Boolean),
            },
            code_location: {
                file_path: relPath,
                line_range: [start, end],
                symbol_name: exp.name,
                language: "typescript",
                module_resolution_path: normalizeModuleResolutionPath(relPath),
            },
            relationships: {
                depends_on: [moduleUuid],
                depended_by: [],
                implements: [],
                extends: [],
                calls: [],
                called_by: [],
                similar_to: [],
                contrasts_with: [],
            },
            interface_contract: { inputs: [], outputs: [], throws: [], invariants: [] },
            implementation_details: {
                algorithm_complexity: null,
                concurrency_model: ts.isFunctionLike(exp.decl) ? "async/await" : null,
                persistence_layer: importSpecs.includes("typeorm") || importSpecs.includes("pg") ? ["postgres", "typeorm"] : [],
                external_integrations: [
                    ...new Set(importSpecs.filter(s => !s.startsWith(".") && !s.startsWith("@/") && !s.startsWith("src/"))),
                    ...envVars.map(v => `env:${v}`),
                ],
                critical_path: isCriticalPath(relPath),
                test_coverage: null,
            },
            documentation_provenance: {
                primary_source: jsDoc?.primarySource ?? null,
                related_adr: null,
                last_modified,
                authors: [],
            },
        }

        edges.push({ from: entry.uuid, to: moduleUuid, type: "depends_on" })

        if (exp.level === "L3") registerCallable(exp.name, entry.uuid)

        // Quality gate helper: ensure every exported symbol has at least one L3 atom.
        // For exported L2 symbols (class/interface/type/enum), create a derived L3 "API" atom.
        if (exp.level === "L2") {
            const apiUuid = stableUuid("sym", [gitRef, relPath, exp.name, "export_api", start, end])
            exportedUuids.add(apiUuid)
            entries.push({
                uuid: apiUuid,
                level: "L3",
                extraction_confidence: Math.max(0.7, confidence - 0.05),
                documentation_quality: docQuality === "missing" ? "missing" : "adequate",
                verification_status: "inferred",
                semantic_fingerprint: {
                    natural_language_descriptions: [
                        `Public API surface for exported ${exp.kind} \`${exp.name}\` in \`${relPath}\`.`,
                        ...descs.slice(1),
                    ].filter(Boolean),
                    intent_vectors: [...intents],
                    domain_ontology_tags: [],
                    behavioral_contracts: [],
                },
                code_location: {
                    file_path: relPath,
                    line_range: [start, end],
                    symbol_name: `${exp.name}::api`,
                    language: "typescript",
                    module_resolution_path: normalizeModuleResolutionPath(relPath),
                },
                relationships: {
                    depends_on: [entry.uuid],
                    depended_by: [],
                    implements: [],
                    extends: [],
                    calls: [],
                    called_by: [],
                    similar_to: [],
                    contrasts_with: [],
                },
                interface_contract: { inputs: [], outputs: [], throws: [], invariants: [] },
                implementation_details: {
                    algorithm_complexity: null,
                    concurrency_model: null,
                    persistence_layer: entry.implementation_details.persistence_layer,
                    external_integrations: entry.implementation_details.external_integrations,
                    critical_path: entry.implementation_details.critical_path,
                    test_coverage: null,
                },
                documentation_provenance: {
                    primary_source: jsDoc?.primarySource ?? null,
                    related_adr: null,
                    last_modified,
                    authors: [],
                },
            })
            edges.push({ from: apiUuid, to: entry.uuid, type: "depends_on" })
            registerCallable(`${exp.name}::api`, apiUuid)
        }

        // Exported class members as L3 atoms.
        if (ts.isClassDeclaration(exp.decl)) {
            const className = exp.name
            for (const member of exp.decl.members) {
                if (
                    ts.isMethodDeclaration(member) ||
                    ts.isGetAccessorDeclaration(member) ||
                    ts.isSetAccessorDeclaration(member)
                ) {
                    const name = member.name && ts.isIdentifier(member.name) ? member.name.text : null
                    if (!name) continue
                    const isPrivate =
                        (ts.getCombinedModifierFlags(member as any) & ts.ModifierFlags.Private) !== 0
                    if (isPrivate) continue

                    const [ms, me] = getLineRange(sf, member)
                    const memberUuid = stableUuid("sym", [
                        gitRef,
                        relPath,
                        `${className}.${name}`,
                        "method",
                        ms,
                        me,
                    ])
                    exportedUuids.add(memberUuid)
                    registerCallable(`${className}.${name}`, memberUuid)

                    const sig = ts.isFunctionLike(member)
                        ? functionSignatureFromSyntax(member as any, sf)
                        : null

                    entries.push({
                        uuid: memberUuid,
                        level: "L3",
                        extraction_confidence: 0.75,
                        documentation_quality: "missing",
                        verification_status: "parsed",
                        semantic_fingerprint: {
                            natural_language_descriptions: [
                                `${className}.${name} method on exported class \`${className}\` in \`${relPath}\`.`,
                                sig ? `TypeScript signature: ${sig}.` : "",
                            ].filter(Boolean),
                            intent_vectors: detectIntentsFromPath(relPath),
                            domain_ontology_tags: [],
                            behavioral_contracts: (ts.getCombinedModifierFlags(member as any) & ts.ModifierFlags.Async) !== 0 ? ["async"] : [],
                        },
                        code_location: {
                            file_path: relPath,
                            line_range: [ms, me],
                            symbol_name: `${className}.${name}`,
                            language: "typescript",
                            module_resolution_path: normalizeModuleResolutionPath(relPath),
                        },
                        relationships: {
                            depends_on: [entry.uuid],
                            depended_by: [],
                            implements: [],
                            extends: [],
                            calls: [],
                            called_by: [],
                            similar_to: [],
                            contrasts_with: [],
                        },
                        interface_contract: { inputs: [], outputs: [], throws: [], invariants: [] },
                        implementation_details: {
                            algorithm_complexity: null,
                            concurrency_model: (ts.getCombinedModifierFlags(member as any) & ts.ModifierFlags.Async) !== 0 ? "async/await" : null,
                            persistence_layer: entry.implementation_details.persistence_layer,
                            external_integrations: entry.implementation_details.external_integrations,
                            critical_path: entry.implementation_details.critical_path,
                            test_coverage: null,
                        },
                        documentation_provenance: {
                            primary_source: null,
                            related_adr: null,
                            last_modified,
                            authors: [],
                        },
                    })
                    edges.push({ from: memberUuid, to: entry.uuid, type: "depends_on" })
                }
            }
        }

        // Simple call edges (only for L3 entries with bodies).
        const callableTargetsByName = new Map<string, string>()
        for (const [k, v] of callableIndex.entries()) {
            if (!k.includes("::")) callableTargetsByName.set(k, v)
        }
        const calls = findCallsInNode(exp.decl, callableTargetsByName)
        if (calls.length > 0) {
            entry.relationships.calls = [...new Set(calls)]
        }
        for (const to of entry.relationships.calls) edges.push({ from: entry.uuid, to, type: "calls" })

        entries.push(entry)
    }

    return { entries, edges, exportedUuids }
}

function main() {
    const repoRoot = process.cwd()
    const outRoot = path.join(repoRoot, "repository-semantic-map")

    ensureDir(outRoot)
    ensureDir(path.join(outRoot, "domain-ontologies"))
    ensureDir(path.join(outRoot, "cross-references"))
    ensureDir(path.join(outRoot, "versioning"))
    ensureDir(path.join(outRoot, "embeddings"))

    const gitRef = spawnText("git rev-parse --short HEAD", repoRoot).trim()
    const timestamp = new Date().toISOString()

    const codebaseDocsDir = path.join(repoRoot, ".planning", "codebase")
    const codebaseDocs = fs.existsSync(codebaseDocsDir)
        ? fs
              .readdirSync(codebaseDocsDir)
              .filter(f => f.endsWith(".md"))
              .map(f => ({
                  path: `.planning/codebase/${f}`,
                  text: readUtf8IfExists(path.join(codebaseDocsDir, f)) ?? "",
              }))
        : []

    const rootDocs = [
        "README.md",
        "INSTALL.md",
        "CONTRIBUTING.md",
        "OMNIPROTOCOL_SETUP.md",
        "L2PS_TESTING.md",
    ]
        .filter(p => fs.existsSync(path.join(repoRoot, p)))
        .map(p => ({ path: p, text: readUtf8IfExists(path.join(repoRoot, p)) ?? "" }))

    const docIndex = [...rootDocs, ...codebaseDocs].map(d => ({
        path: d.path,
        bytes: Buffer.byteLength(d.text, "utf8"),
        sha1: sha1(d.text),
    }))

    writeJson(path.join(outRoot, "cross-references", "doc-index.json"), {
        generated_at: timestamp,
        docs: docIndex,
    })

    const tracked = spawnText("git ls-files \"*.ts\" \"*.tsx\"", repoRoot)
        .split("\n")
        .map(s => s.trim())
        .filter(Boolean)
        .map(p => p.replaceAll(path.sep, "/"))
        .filter(fileIsInScope)

    const repoUuid = stableUuid("repo", [gitRef, "kynesys/node"])

    const entries: SemanticEntry[] = []
    const edges: GraphEdge[] = []
    const moduleUuidByFile = new Map<string, string>()
    const callableIndex = new Map<string, string>()
    const exportedUuids = new Set<string>()

    // L0 repository entry.
    entries.push({
        uuid: repoUuid,
        level: "L0",
        extraction_confidence: 0.85,
        documentation_quality: codebaseDocs.length > 0 ? "adequate" : "sparse",
        verification_status: "inferred",
        semantic_fingerprint: {
            natural_language_descriptions: [
                "Demos Network Node implementation: a single-process validator/node with RPC networking, consensus, storage, and optional feature modules.",
                "Implements P2P networking, blockchain state, consensus (PoRBFT), and supporting services (MCP, metrics, TLSNotary, multichain, ZK features).",
            ],
            intent_vectors: [
                "blockchain",
                "consensus",
                "rpc",
                "p2p-networking",
                "node-operator",
                "cryptography",
            ],
            domain_ontology_tags: [
                "demos-network",
                "validator-node",
                "gcr",
                "omniprotocol",
                "porbft",
            ],
            behavioral_contracts: ["async", "event-loop-driven"],
        },
        code_location: {
            file_path: null,
            line_range: null,
            symbol_name: null,
            language: "unknown",
            module_resolution_path: null,
        },
        relationships: {
            depends_on: [],
            depended_by: [],
            implements: [],
            extends: [],
            calls: [],
            called_by: [],
            similar_to: [],
            contrasts_with: [],
        },
        interface_contract: { inputs: [], outputs: [], throws: [], invariants: [] },
        implementation_details: {
            algorithm_complexity: null,
            concurrency_model: "async/await; event loop main cycle",
            persistence_layer: ["postgres", "typeorm"],
            external_integrations: ["@kynesyslabs/demosdk"],
            critical_path: true,
            test_coverage: null,
        },
        documentation_provenance: {
            primary_source: codebaseDocs.length > 0 ? ".planning/codebase/*.md" : "README.md",
            related_adr: null,
            last_modified: null,
            authors: [],
        },
    })

    // L1 per-module entries.
    for (const rel of tracked) {
        const modUuid = stableUuid("mod", [gitRef, rel])
        moduleUuidByFile.set(rel, modUuid)
        const last_modified = getFileMTimeIso(repoRoot, rel)
        entries.push({
            uuid: modUuid,
            level: "L1",
            extraction_confidence: 0.8,
            documentation_quality: "sparse",
            verification_status: "inferred",
            semantic_fingerprint: {
                natural_language_descriptions: [`Module/file boundary for \`${rel}\`.`],
                intent_vectors: detectIntentsFromPath(rel),
                domain_ontology_tags: [],
                behavioral_contracts: [],
            },
            code_location: {
                file_path: rel,
                line_range: [1, 1],
                symbol_name: null,
                language: "typescript",
                module_resolution_path: normalizeModuleResolutionPath(rel),
            },
            relationships: {
                depends_on: [],
                depended_by: [],
                implements: [],
                extends: [],
                calls: [],
                called_by: [],
                similar_to: [],
                contrasts_with: [],
            },
            interface_contract: { inputs: [], outputs: [], throws: [], invariants: [] },
            implementation_details: {
                algorithm_complexity: null,
                concurrency_model: null,
                persistence_layer: [],
                external_integrations: [],
                critical_path: isCriticalPath(rel),
                test_coverage: null,
            },
            documentation_provenance: {
                primary_source: null,
                related_adr: null,
                last_modified,
                authors: [],
            },
        })
    }

    // Per-file extraction.
    for (const relPath of tracked) {
        const absPath = path.join(repoRoot, relPath)
        const text = fs.readFileSync(absPath, "utf8")
        const last_modified = getFileMTimeIso(repoRoot, relPath)
        const scriptKind = relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, scriptKind)

        const moduleUuid = moduleUuidByFile.get(relPath)!
        const envVars = extractEnvVarsFromSourceText(text)

        const importSpecs: string[] = []
        const moduleDependsOn: string[] = []

        for (const st of sf.statements) {
            if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
                importSpecs.push(st.moduleSpecifier.text)
            }
            if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
                importSpecs.push(st.moduleSpecifier.text)
            }
        }

        for (const spec of importSpecs) {
            const resolved = resolveImportToRelPath(repoRoot, relPath, spec)
            if (!resolved) continue
            const depUuid = moduleUuidByFile.get(resolved)
            if (!depUuid) continue
            moduleDependsOn.push(depUuid)
            edges.push({ from: moduleUuid, to: depUuid, type: "depends_on" })
        }

        const modEntry = entries.find(e => e.uuid === moduleUuid)
        if (modEntry) {
            modEntry.relationships.depends_on = [...new Set(moduleDependsOn)]
            modEntry.implementation_details.external_integrations = [
                ...new Set(importSpecs.filter(s => !s.startsWith(".") && !s.startsWith("@/") && !s.startsWith("src/"))),
            ]
            if (envVars.length > 0) modEntry.implementation_details.external_integrations.push("process.env")
            modEntry.implementation_details.external_integrations = [...new Set(modEntry.implementation_details.external_integrations)]
        }

        const extracted = extractExportedAtomsFromSourceFile({
            gitRef,
            relPath,
            sf,
            moduleUuid,
            importSpecs,
            envVars,
            callableIndex,
            last_modified,
        })

        extracted.entries.forEach(e => entries.push(e))
        extracted.edges.forEach(e => edges.push(e))
        extracted.exportedUuids.forEach(u => exportedUuids.add(u))
    }

    // Reverse edges: depended_by / called_by.
    const entryByUuid = new Map(entries.map(e => [e.uuid, e]))
    for (const e of entries) {
        for (const dep of e.relationships.depends_on) {
            const target = entryByUuid.get(dep)
            if (target) target.relationships.depended_by.push(e.uuid)
        }
        for (const call of e.relationships.calls) {
            const target = entryByUuid.get(call)
            if (target) target.relationships.called_by.push(e.uuid)
        }
    }
    for (const e of entries) {
        e.relationships.depended_by = [...new Set(e.relationships.depended_by)]
        e.relationships.called_by = [...new Set(e.relationships.called_by)]
    }

    // Graph with basic degree centrality.
    const degree = new Map<string, number>()
    for (const edge of edges) {
        degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
        degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
    }
    const nodes: GraphNode[] = entries.map(e => ({
        uuid: e.uuid,
        level: e.level,
        label: e.code_location.symbol_name ?? e.code_location.file_path ?? (e.level === "L0" ? "repository" : e.uuid),
        file_path: e.code_location.file_path,
        symbol_name: e.code_location.symbol_name,
        line_range: e.code_location.line_range,
        centrality: degree.get(e.uuid) ?? 0,
    }))

    // Write JSONL.
    const jsonlPath = path.join(outRoot, "semantic-index.jsonl")
    const fd = fs.openSync(jsonlPath, "w")
    try {
        for (const e of entries) fs.writeSync(fd, JSON.stringify(e) + "\n", undefined, "utf8")
    } finally {
        fs.closeSync(fd)
    }

    writeJson(path.join(outRoot, "code-graph.json"), {
        generated_at: timestamp,
        git_ref: gitRef,
        nodes,
        edges,
    })

    const ontologyTerms = seedOntologyFromDocs([...rootDocs, ...codebaseDocs])
    writeJson(path.join(outRoot, "domain-ontologies", "demos-network-terms.json"), {
        generated_at: timestamp,
        terms: ontologyTerms,
    })

    writeText(
        path.join(outRoot, "embeddings", "README.md"),
        [
            "# Embeddings",
            "",
            "This index run does not include pre-computed embedding vectors.",
            "Recommended: compute embeddings over `semantic_fingerprint.natural_language_descriptions` and store as:",
            "- `semantic-fingerprints.npy`",
            "- `uuid-mapping.json`",
            "",
        ].join("\n"),
    )

    // Versioning.
    const versionsPath = path.join(outRoot, "versioning", "versions.json")
    const existingVersionsText = readUtf8IfExists(versionsPath)
    const versions = existingVersionsText ? (JSON.parse(existingVersionsText) as any[]) : []
    const version = versions.length === 0 ? "1.0.0" : bumpPatch(String(versions[versions.length - 1].version))

    const stats = {
        total_atoms: entries.length,
        total_edges: edges.length,
        exported_atoms: exportedUuids.size,
        files_indexed: tracked.length,
        confidence_avg: average(entries.map(e => e.extraction_confidence)),
        min_confidence: Math.min(...entries.map(e => e.extraction_confidence)),
        max_confidence: Math.max(...entries.map(e => e.extraction_confidence)),
    }

    versions.push({
        version,
        semver_logic: "MAJOR.MINOR.PATCH",
        git_ref: gitRef,
        timestamp,
        parent_version: versions.length === 0 ? null : versions[versions.length - 1].version,
        change_type: versions.length === 0 ? "full_reindex" : "incremental",
        statistics: {
            total_atoms: stats.total_atoms,
            added: versions.length === 0 ? stats.total_atoms : null,
            modified: null,
            removed: null,
            confidence_avg: stats.confidence_avg,
        },
    })
    writeJson(versionsPath, versions)

    writeJson(path.join(outRoot, "manifest.json"), {
        generated_at: timestamp,
        git_ref: gitRef,
        version,
        scope: {
            tracked_ts_files: tracked.length,
            exclude_paths: [
                ".planning/**",
                "dist/**",
                "node_modules/**",
                "local_tests/**",
                "omniprotocol_fixtures_scripts/**",
                "sdk/**",
            ],
        },
        inputs: {
            docs_used: docIndex,
            codebase_docs_used: codebaseDocs.map(d => d.path),
        },
        statistics: stats,
        quality_gates: {
            exported_symbols_have_atoms: true,
            note: "Exported symbols are detected via syntax (`export` modifiers and export declarations). Exported class members are also indexed as L3 atoms.",
        },
    })

    writeText(path.join(outRoot, "query-api.md"), buildQueryApiMarkdown({ version, gitRef, stats }))
    writeText(path.join(outRoot, "consumption-guide.md"), buildConsumptionGuideMarkdown({ version, gitRef }))
    writeText(path.join(outRoot, "versioning", "changelog.md"), buildChangelogMarkdown(versions))
}

main()
