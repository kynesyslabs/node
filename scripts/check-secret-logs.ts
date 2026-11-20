import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import * as ts from "typescript"

// Check identifiers, dotted properties (a.privateKey), and #private fields in direct log.* and console.* arguments
// for the seven exact names below (case-insensitively), except .length reads.
// Bracket property names (a["privateKey"]), other loggers, and renamed values are not checked.
const secretName = /^(bridgePrivateKey|shardKey|signingKey|privateKey|mnemonic|seedPhrase|secretKey)$/i

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return sourceFiles(path)
        return entry.isFile() && entry.name.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(entry.name)
            ? [path]
            : []
    })
}

function containsSecret(node: ts.Node): boolean {
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && secretName.test(node.text.replace(/^#/, ""))) {
        const use = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
            ? node.parent
            : node
        const next = use.parent
        if (!(ts.isPropertyAccessExpression(next) && next.expression === use && next.name.text === "length")) {
            return true
        }
    }
    return ts.forEachChild(node, child => containsSecret(child) || undefined) === true
}

export function findSecretLogs(root: string): string[] {
    const hits: string[] = []
    for (const path of sourceFiles(join(root, "src"))) {
        const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
                const receiver = node.expression.expression
                if (ts.isIdentifier(receiver) && (receiver.text === "log" || receiver.text === "console") &&
                    node.arguments.some(containsSecret)) {
                    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
                    hits.push(`${relative(root, path)}:${line}`)
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(source)
    }
    return hits
}

if (import.meta.main) {
    const hits = findSecretLogs(join(import.meta.dir, ".."))
    for (const hit of hits) console.error(hit)
    if (hits.length) process.exitCode = 1
}
