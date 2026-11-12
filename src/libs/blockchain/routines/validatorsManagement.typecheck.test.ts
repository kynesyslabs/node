import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

test("validator management typecheck runs in the consensus suite", () => {
    const script = readFileSync(path.resolve(import.meta.dir, "../../../../scripts/test-consensus.sh"), "utf8")
    const suiteFiles = script.match(/SUITE_FILES=\(([\s\S]*?)\n\)/)?.[1]
    expect(suiteFiles?.split(/\s+/)).toContain("src/libs/blockchain/routines/validatorsManagement.typecheck.test.ts")
})

test("validator management has no TypeScript diagnostics", () => {
    const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, "tsconfig.json")
    if (!configPath) throw new Error("tsconfig.json not found")

    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath))
    const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true })
    const source = path.resolve(import.meta.dir, "validatorsManagement.ts")
    const sourceFile = program.getSourceFile(source)
    if (!sourceFile) throw new Error("validatorsManagement.ts not found in tsconfig")
    const diagnostics = ts.getPreEmitDiagnostics(program, sourceFile)
        .filter((diagnostic) => diagnostic.file?.fileName === source)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))

    expect(diagnostics).toEqual([])
}, 60_000)
