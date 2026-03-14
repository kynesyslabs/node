export interface TLSConfig {
    enabled: boolean // Enable TLS
    mode: "self-signed" | "ca" // Certificate mode
    certPath: string // Path to certificate file
    keyPath: string // Path to private key file
    caPath?: string // Path to CA certificate (optional)
    rejectUnauthorized: boolean // Verify peer certificates
    minVersion: "TLSv1.2" | "TLSv1.3" // Minimum TLS version
    ciphers?: string // Allowed cipher suites
    requestCert: boolean // Require client certificates
    trustedFingerprints?: Map<string, string> // Peer identity → cert fingerprint
}

export interface CertificateInfo {
    subject: {
        commonName: string
        country?: string
        organization?: string
    }
    issuer: {
        commonName: string
    }
    validFrom: Date
    validTo: Date
    fingerprint: string
    fingerprint256: string
    serialNumber: string
}

export interface CertificateGenerationOptions {
    commonName?: string
    country?: string
    organization?: string
    validityDays?: number
    keySize?: number
}

export const DEFAULT_TLS_CONFIG: Partial<TLSConfig> = {
    enabled: false,
    mode: "self-signed",
    rejectUnauthorized: false, // Custom verification
    minVersion: "TLSv1.3",
    requestCert: true,
    ciphers: [
        "ECDHE-ECDSA-AES256-GCM-SHA384",
        "ECDHE-RSA-AES256-GCM-SHA384",
        "ECDHE-ECDSA-CHACHA20-POLY1305",
        "ECDHE-RSA-CHACHA20-POLY1305",
        "ECDHE-ECDSA-AES128-GCM-SHA256",
        "ECDHE-RSA-AES128-GCM-SHA256",
    ].join(":"),
}
