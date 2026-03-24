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
