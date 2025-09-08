/**
 * Contract syntax validation tests
 * Tests that example contracts have valid TypeScript syntax and structure
 */

import { describe, it, expect } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { validateContractSource } from "../validation/ContractValidator"

describe("Contract Syntax Validation", () => {
    const examplesDir = join(__dirname, "../examples")

    const exampleContracts = [
        {
            name: "SimpleStorageContract",
            file: "SimpleStorageContract.ts",
        },
        {
            name: "SimpleTransferContract",
            file: "SimpleTransferContract.ts",
        },
        {
            name: "DemosTransferContract",
            file: "DemosTransferContract.ts",
        },
    ]

    describe("Example Contract Validation", () => {
        exampleContracts.forEach(({ name, file }) => {
            it(`should validate ${name} syntax`, () => {
                const contractPath = join(examplesDir, file)
                const contractSource = readFileSync(contractPath, "utf-8")

                const result = validateContractSource(contractSource)

                expect(result.valid).toBe(true)
                expect(result.error).toBeUndefined()
                if (result.compiledJS) {
                    expect(result.compiledJS.length).toBeGreaterThan(0)
                }
            })
        })
    })

    describe("Invalid Contract Detection", () => {
        it("should detect syntax errors", () => {
            const invalidContract = `
                import { DemosContract } from "../execution/ContractBase"
                export class SyntaxErrorContract extends DemosContract {
                    broken() {
                        const x: string = 123; // Type error
                        return x..length; // Syntax error
                    }
                }
            `

            const result = validateContractSource(invalidContract)
            expect(result.valid).toBe(false)
            expect(result.error).toBeDefined()
        })

        it("should detect missing DemosContract extension", () => {
            const invalidContract = `
                export class BadContract {
                    someMethod() {
                        return "not a demos contract"
                    }
                }
            `

            const result = validateContractSource(invalidContract)
            expect(result.valid).toBe(false)
            expect(result.error).toContain("extend DemosContract")
        })

        it("should detect missing import", () => {
            const invalidContract = `
                export class TestContract extends DemosContract {
                    someMethod() {
                        return "missing import"
                    }
                }
            `

            const result = validateContractSource(invalidContract)
            expect(result.valid).toBe(false)
            expect(result.error).toContain("import DemosContract")
        })

        it("should detect banned APIs", () => {
            const maliciousContract = `
                import { DemosContract } from "../execution/ContractBase"
                export class MaliciousContract extends DemosContract {
                    hack() {
                        const fs = require('fs') // Banned API
                        return fs.readFileSync('/etc/passwd')
                    }
                }
            `

            const result = validateContractSource(maliciousContract)
            expect(result.valid).toBe(false)
            expect(result.error).toContain("banned API")
        })

        it("should detect oversized contracts", () => {
            // Create a contract that exceeds size limit
            const largeCode = "x".repeat(300000) // 300KB to exceed limit
            const oversizedContract = `
                import { DemosContract } from "../execution/ContractBase"
                export class OversizedContract extends DemosContract {
                    huge() {
                        const data = "${largeCode}"
                        return data.length
                    }
                }
            `

            const result = validateContractSource(oversizedContract)
            expect(result.valid).toBe(false)
            expect(result.error).toContain("exceeds maximum")
        })
    })
})
