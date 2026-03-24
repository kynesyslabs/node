import { SingleBar } from "cli-progress"
import dotenv from "dotenv"
import fs from "fs"
import https from "https"
import nodeDiskInfo from "node-disk-info"
import os from "os"

export interface DiagnosticData {
    network: {
        usageHistory: any
        downloadSpeed?: number
        uploadSpeed?: number
    }
    cpu: {
        benchmarkUsage: number
        type: string
        info: string
        currentUsage: number
        averageUsage: number
    }
    ram: {
        type: string
        info: string
        currentUsage: number
        averageUsage: number
        benchmarkUsage: number // Add this line
    }
    disk: {
        type: string
        info: string
        currentUsage: number
        averageUsage: number
        benchmarkUsage: number // Add this line
    }
}

export interface DiagnosticResponse {
    diagnostics: DiagnosticData
}

class Diagnostic {
    private static cpuUsageHistory: number[] = []
    private static ramUsageHistory: number[] = []
    private static diskUsageHistory: number[] = []
    private static networkUsageHistory: any = []

    private static getCPUInfo(): { type: string; info: string } {
        const cpus = os.cpus()
        return {
            type: cpus[0].model,
            info: `${cpus.length} cores @ ${cpus[0].speed} MHz`,
        }
    }

    private static getCPUUsage(): number {
        const cpus = os.cpus()
        const totalIdle = cpus.reduce((acc, cpu) => acc + cpu.times.idle, 0)
        const totalTick = cpus.reduce(
            (acc, cpu) =>
                acc + Object.values(cpu.times).reduce((a, b) => a + b, 0),
            0,
        )
        return 100 - (100 * totalIdle) / totalTick
    }

    private static getRAMInfo(): { type: string; info: string } {
        return {
            type: "System RAM",
            info: `${Math.round(
                os.totalmem() / (1024 * 1024 * 1024),
            )} GB total`,
        }
    }

    private static getRAMUsage(): number {
        const totalMem = os.totalmem()
        const freeMem = os.freemem()
        const usedMem = totalMem - freeMem

        // On Linux, we can get cached memory from /proc/meminfo
        let cachedMem = 0
        if (process.platform === "linux") {
            try {
                const memInfo = fs.readFileSync("/proc/meminfo", "utf8")
                const cached = memInfo.match(/Cached:\s+(\d+)/)
                if (cached) {
                    cachedMem = parseInt(cached[1], 10) * 1024 // Convert to bytes
                }
            } catch (error) {
                console.error("Error reading /proc/meminfo:", error)
            }
        }

        const actualUsedMem = usedMem - cachedMem
        return (actualUsedMem / totalMem) * 100
    }

    private static getDiskInfo(): { type: string; info: string } {
        // This is a placeholder. In a real-world scenario, you'd use a library like `diskusage` to get accurate disk information.
        return {
            type: "System Disk",
            info: "Primary storage device",
        }
    }

    private static getDiskUsage(): number {
        try {
            const disks = nodeDiskInfo.getDiskInfoSync()
            const mainDisk =
                disks.find(disk => disk.mounted === "/") || disks[0]
            if (mainDisk) {
                return parseInt(mainDisk.capacity, 10)
            }
        } catch (error) {
            console.error("Error getting disk usage:", error)
        }

        // Fallback to placeholder if there's an error
        return 0
    }

    public static insertDiagnostics(json: any): void {
        const cpuUsage = this.getCPUUsage()
        const ramUsage = this.getRAMUsage()
        const diskUsage = this.getDiskUsage()

        this.cpuUsageHistory.push(cpuUsage)
        this.ramUsageHistory.push(ramUsage)
        this.diskUsageHistory.push(diskUsage)

        const diagnosticData: DiagnosticData = {
            cpu: {
                ...this.getCPUInfo(),
                currentUsage: cpuUsage,
                averageUsage:
                    this.cpuUsageHistory.reduce((a, b) => a + b, 0) /
                    this.cpuUsageHistory.length,
                benchmarkUsage: 0,
            },
            ram: {
                ...this.getRAMInfo(),
                currentUsage: ramUsage,
                averageUsage:
                    this.ramUsageHistory.reduce((a, b) => a + b, 0) /
                    this.ramUsageHistory.length,
                benchmarkUsage: 0,
            },
            disk: {
                ...this.getDiskInfo(),
                currentUsage: diskUsage,
                averageUsage:
                    this.diskUsageHistory.reduce((a, b) => a + b, 0) /
                    this.diskUsageHistory.length,
                benchmarkUsage: 0,
            },
            network: {
                usageHistory: [],
            },
        }

        if (this.networkUsageHistory.length > 0) {
            diagnosticData.network = {
                usageHistory: this.networkUsageHistory,
            }
        }

        json.diagnostics = diagnosticData
    }

    public static async benchmark(progressBar: SingleBar): Promise<{
        meetsMinimum: boolean
        meetsSuggested: boolean
        details: Record<
            string,
            {
                meetsMinimum: boolean
                meetsSuggested: boolean
                value: number | { download: number; upload: number }
            }
        >
    }> {
        console.log("Starting system benchmark...")
        progressBar.start(100, 0)

        // Load requirements from .requirements file
        dotenv.config({ path: ".requirements" })

        const minRequirements = {
            cpu: Number(process.env.MIN_CPU_SPEED),
            ram: Number(process.env.MIN_RAM),
            disk: Number(process.env.MIN_DISK_SPACE),
            networkDownload: Number(process.env.MIN_NETWORK_DOWNLOAD_SPEED),
            networkUpload: Number(process.env.MIN_NETWORK_UPLOAD_SPEED),
            networkTestFileSize: Number(process.env.NETWORK_TEST_FILE_SIZE),
        }

        const suggestedRequirements = {
            cpu: Number(process.env.SUGGESTED_CPU_SPEED) || minRequirements.cpu,
            ram: Number(process.env.SUGGESTED_RAM) || minRequirements.ram,
            disk:
                Number(process.env.SUGGESTED_DISK_SPACE) ||
                minRequirements.disk,
            networkDownload:
                Number(process.env.SUGGESTED_NETWORK_DOWNLOAD_SPEED) ||
                minRequirements.networkDownload,
            networkUpload:
                Number(process.env.SUGGESTED_NETWORK_UPLOAD_SPEED) ||
                minRequirements.networkUpload,
        }

        console.log("Checking CPU...")
        progressBar.update(20)
        const cpuResult = this.checkCPU(
            minRequirements.cpu,
            suggestedRequirements.cpu,
        )

        console.log("Checking RAM...")
        progressBar.update(40)
        const ramResult = this.checkRAM(
            minRequirements.ram,
            suggestedRequirements.ram,
        )

        console.log("Checking Disk...")
        progressBar.update(60)
        const diskResult = this.checkDisk(
            minRequirements.disk,
            suggestedRequirements.disk,
        )

        console.log("Checking Network...")
        const networkResult = await this.checkNetwork(
            minRequirements.networkDownload,
            minRequirements.networkUpload,
            suggestedRequirements.networkDownload,
            suggestedRequirements.networkUpload,
            minRequirements.networkTestFileSize,
            progressBar,
        )

        progressBar.update(100)
        progressBar.stop()

        const results = {
            cpu: cpuResult,
            ram: ramResult,
            disk: diskResult,
            network: networkResult,
        }

        const meetsMinimum = Object.values(results).every(
            result => result.meetsMinimum,
        )
        const meetsSuggested = Object.values(results).every(
            result => result.meetsSuggested,
        )

        return {
            meetsMinimum,
            meetsSuggested,
            details: results,
        }
    }

    private static checkCPU(
        minSpeed: number,
        suggestedSpeed: number,
    ): {
        meetsMinimum: boolean
        meetsSuggested: boolean
        value: number
    } {
        const cpuInfo = os.cpus()[0]
        return {
            meetsMinimum: cpuInfo.speed >= minSpeed,
            meetsSuggested: cpuInfo.speed >= suggestedSpeed,
            value: cpuInfo.speed,
        }
    }

    private static checkRAM(
        minRAM: number,
        suggestedRAM: number,
    ): {
        meetsMinimum: boolean
        meetsSuggested: boolean
        value: number
    } {
        const totalRAM = os.totalmem() / (1024 * 1024 * 1024) // Convert to GB
        return {
            meetsMinimum: totalRAM >= minRAM,
            meetsSuggested: totalRAM >= suggestedRAM,
            value: totalRAM,
        }
    }

    private static checkDisk(
        minSpace: number,
        suggestedSpace: number,
    ): {
        meetsMinimum: boolean
        meetsSuggested: boolean
        value: number
    } {
        // Note: This is a placeholder. You'll need to use a library like `diskusage` for accurate results
        const freeSpace = 100 // Placeholder value in GB
        return {
            meetsMinimum: freeSpace >= minSpace,
            meetsSuggested: freeSpace >= suggestedSpace,
            value: freeSpace,
        }
    }

    private static async checkNetwork(
        minDownloadSpeed: number,
        minUploadSpeed: number,
        suggestedDownloadSpeed: number,
        suggestedUploadSpeed: number,
        testFileSizeBytes: number,
        progressBar: SingleBar,
    ): Promise<{
        meetsMinimum: boolean
        meetsSuggested: boolean
        value: { download: number; upload: number }
    }> {
        console.log("Measuring download speed...")
        progressBar.update(70)
        const downloadSpeed = await this.measureDownloadSpeed(testFileSizeBytes)

        console.log("Measuring upload speed...")
        progressBar.update(90)
        const uploadSpeed = await this.measureUploadSpeed(testFileSizeBytes)

        return {
            meetsMinimum:
                downloadSpeed >= minDownloadSpeed &&
                uploadSpeed >= minUploadSpeed,
            meetsSuggested:
                downloadSpeed >= suggestedDownloadSpeed &&
                uploadSpeed >= suggestedUploadSpeed,
            value: { download: downloadSpeed, upload: uploadSpeed },
        }
    }

    private static async measureDownloadSpeed(
        testFileSizeBytes: number,
    ): Promise<number> {
        const url = `https://speed.cloudflare.com/__down?bytes=${testFileSizeBytes}`
        const startTime = Date.now()

        return new Promise((resolve, reject) => {
            https
                .get(url, res => {
                    let downloadedBytes = 0

                    res.on("data", chunk => {
                        downloadedBytes += chunk.length
                    })

                    res.on("end", () => {
                        const endTime = Date.now()
                        const durationSeconds = (endTime - startTime) / 1000
                        const speedMbps =
                            (downloadedBytes * 8) / (durationSeconds * 1000000)
                        resolve(this.validateSpeed(speedMbps))
                    })
                })
                .on("error", err => {
                    reject(err)
                })
        })
    }

    private static async measureUploadSpeed(
        testFileSizeBytes: number,
    ): Promise<number> {
        const url = "https://speed.cloudflare.com/__up"
        const data = Buffer.alloc(testFileSizeBytes)
        const startTime = Date.now()

        return new Promise((resolve, reject) => {
            const req = https.request(
                url,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/octet-stream",
                        "Content-Length": testFileSizeBytes,
                    },
                },
                res => {
                    res.on("data", () => {}) // Drain the response

                    res.on("end", () => {
                        const endTime = Date.now()
                        const durationSeconds = (endTime - startTime) / 1000
                        const speedMbps =
                            (testFileSizeBytes * 8) /
                            (durationSeconds * 1000000)
                        resolve(this.validateSpeed(speedMbps))
                    })
                },
            )

            req.on("error", err => {
                reject(err)
            })

            req.write(data)
            req.end()
        })
    }

    private static validateSpeed(speed: number): number {
        if (!isFinite(speed) || speed < 0) {
            console.warn(
                `Invalid speed detected: ${speed}. Retrying measurement...`,
            )
            throw new Error("Invalid speed measurement")
        }
        return speed
    }
}

export default Diagnostic
