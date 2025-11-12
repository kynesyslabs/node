/**
 * Merkle Tree Manager Tests
 *
 * Tests for the global identity commitment Merkle tree
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { MerkleTreeManager } from "../merkle/MerkleTreeManager.js"
import Datasource from "@/model/datasource.js"

describe("MerkleTreeManager", () => {
    let merkleManager: MerkleTreeManager

    beforeEach(async () => {
        // Initialize database connection and get DataSource
        const db = await Datasource.getInstance()
        const dataSource = db.getDataSource()

        // Create a test Merkle tree manager with unique namespace per test
        const testId = Math.random().toString(36).substring(7)
        merkleManager = new MerkleTreeManager(dataSource, 20, `test_${testId}`)
        await merkleManager.initialize()
    })

    it("should initialize an empty tree", () => {
        const stats = merkleManager.getStats()
        expect(stats.depth).toBe(20)
        expect(stats.capacity).toBe(Math.pow(2, 20))
    })

    it("should add commitments and update root", () => {
        const commitment1 = "12345678901234567890"
        const commitment2 = "98765432109876543210"

        const initialRoot = merkleManager.getRoot()

        const leafIndex1 = merkleManager.addCommitment(commitment1)
        expect(leafIndex1).toBe(0)

        const rootAfterFirst = merkleManager.getRoot()
        expect(rootAfterFirst).not.toBe(initialRoot)

        const leafIndex2 = merkleManager.addCommitment(commitment2)
        expect(leafIndex2).toBe(1)

        const rootAfterSecond = merkleManager.getRoot()
        expect(rootAfterSecond).not.toBe(rootAfterFirst)

        const stats = merkleManager.getStats()
        expect(stats.leafCount).toBe(2)
    })

    it("should generate valid Merkle proofs", () => {
        const commitment = "11111111111111111111"
        const leafIndex = merkleManager.addCommitment(commitment)

        const proof = merkleManager.generateProof(leafIndex)

        expect(proof.leaf).toBe(commitment)
        expect(proof.root).toBe(merkleManager.getRoot())
        expect(proof.siblings.length).toBeGreaterThan(0)
        expect(proof.pathIndices.length).toBeGreaterThan(0)
    })

    it("should save and load tree state from database", async () => {
        // REVIEW: Use a dedicated namespace for this test to ensure save/load consistency
        // Create a manager with a known namespace for this specific test
        const db = await Datasource.getInstance()
        const dataSource = db.getDataSource()
        const testManager = new MerkleTreeManager(dataSource, 20, "test_save_load")
        await testManager.initialize()

        // Add some commitments
        testManager.addCommitment("1111")
        testManager.addCommitment("2222")
        testManager.addCommitment("3333")

        const rootBeforeSave = testManager.getRoot()
        const leafCountBeforeSave = testManager.getLeafCount()

        // Save to database
        await testManager.saveToDatabase(1)

        // Create a new manager and load from database with matching namespace
        const db2 = await Datasource.getInstance()
        const dataSource2 = db2.getDataSource()
        const newManager = new MerkleTreeManager(dataSource2, 20, "test_save_load")
        const loaded = await newManager.initialize()

        expect(loaded).toBe(true)
        expect(newManager.getRoot()).toBe(rootBeforeSave)
        expect(newManager.getLeafCount()).toBe(leafCountBeforeSave)
    })

    it("should calculate utilization correctly", () => {
        const stats = merkleManager.getStats()
        const expectedUtilization = (stats.leafCount / stats.capacity) * 100

        expect(stats.utilizationPercent).toBe(expectedUtilization)
        expect(stats.utilizationPercent).toBeLessThan(100)
    })
})
