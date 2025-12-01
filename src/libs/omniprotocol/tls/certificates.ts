import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { promisify } from "util"
import type { CertificateInfo, CertificateGenerationOptions } from "./types"

const generateKeyPair = promisify(crypto.generateKeyPair)

/**
 * Generate a self-signed certificate for the node
 * Uses Ed25519 keys for consistency with OmniProtocol authentication
 */
export async function generateSelfSignedCert(
    certPath: string,
    keyPath: string,
    options: CertificateGenerationOptions = {},
): Promise<{ certPath: string; keyPath: string }> {
    const {
        commonName = `omni-node-${Date.now()}`,
        country = "US",
        organization = "DemosNetwork",
        validityDays = 365,
        keySize = 2048,
    } = options

    console.log(`[TLS] Generating self-signed certificate for ${commonName}...`)

    // Generate RSA key pair (TLS requires RSA/ECDSA, not Ed25519)
    const { publicKey, privateKey } = await generateKeyPair("rsa", {
        modulusLength: keySize,
        publicKeyEncoding: {
            type: "spki",
            format: "pem",
        },
        privateKeyEncoding: {
            type: "pkcs8",
            format: "pem",
        },
    })

    // Create certificate using openssl via child_process
    // This is a simplified version - in production, use a proper library like node-forge
    const { execSync } = require("child_process")

    // Create temporary config file for openssl
    const tempDir = path.dirname(keyPath)
    const configPath = path.join(tempDir, "openssl.cnf")
    const csrPath = path.join(tempDir, "temp.csr")

    const opensslConfig = `
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
C = ${country}
O = ${organization}
CN = ${commonName}

[v3_req]
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
`

    try {
        // Write private key
        await fs.promises.writeFile(keyPath, privateKey, { mode: 0o600 })

        // Write openssl config
        await fs.promises.writeFile(configPath, opensslConfig)

        // Generate self-signed certificate using openssl
        execSync(
            `openssl req -new -x509 -key "${keyPath}" -out "${certPath}" -days ${validityDays} -config "${configPath}"`,
            { stdio: "pipe" },
        )

        // Clean up temp files
        if (fs.existsSync(configPath)) fs.unlinkSync(configPath)
        if (fs.existsSync(csrPath)) fs.unlinkSync(csrPath)

        console.log("[TLS] Certificate generated successfully")
        console.log(`[TLS] Certificate: ${certPath}`)
        console.log(`[TLS] Private key: ${keyPath}`)

        return { certPath, keyPath }
    } catch (error) {
        console.error("[TLS] Failed to generate certificate:", error)
        throw new Error(`Certificate generation failed: ${error.message}`)
    }
}

/**
 * Load certificate from file and extract information
 */
export async function loadCertificate(certPath: string): Promise<CertificateInfo> {
    try {
        const certPem = await fs.promises.readFile(certPath, "utf8")
        const cert = crypto.X509Certificate ? new crypto.X509Certificate(certPem) : null

        if (!cert) {
            throw new Error("X509Certificate not available in this Node.js version")
        }

        return {
            subject: {
                commonName: cert.subject.split("CN=")[1]?.split("\n")[0] || "",
                country: cert.subject.split("C=")[1]?.split("\n")[0],
                organization: cert.subject.split("O=")[1]?.split("\n")[0],
            },
            issuer: {
                commonName: cert.issuer.split("CN=")[1]?.split("\n")[0] || "",
            },
            validFrom: new Date(cert.validFrom),
            validTo: new Date(cert.validTo),
            fingerprint: cert.fingerprint,
            fingerprint256: cert.fingerprint256,
            serialNumber: cert.serialNumber,
        }
    } catch (error) {
        throw new Error(`Failed to load certificate: ${error.message}`)
    }
}

/**
 * Get SHA256 fingerprint from certificate file
 */
export async function getCertificateFingerprint(certPath: string): Promise<string> {
    const certInfo = await loadCertificate(certPath)
    return certInfo.fingerprint256
}

/**
 * Verify certificate validity (not expired, valid dates)
 */
export async function verifyCertificateValidity(certPath: string): Promise<boolean> {
    try {
        const certInfo = await loadCertificate(certPath)
        const now = new Date()

        if (now < certInfo.validFrom) {
            console.warn(`[TLS] Certificate not yet valid (valid from ${certInfo.validFrom})`)
            return false
        }

        if (now > certInfo.validTo) {
            console.warn(`[TLS] Certificate expired (expired on ${certInfo.validTo})`)
            return false
        }

        return true
    } catch (error) {
        console.error("[TLS] Certificate verification failed:", error)
        return false
    }
}

/**
 * Check days until certificate expires
 */
export async function getCertificateExpiryDays(certPath: string): Promise<number> {
    const certInfo = await loadCertificate(certPath)
    const now = new Date()
    const daysUntilExpiry = Math.floor(
        (certInfo.validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    )
    return daysUntilExpiry
}

/**
 * Check if certificate exists
 */
export function certificateExists(certPath: string, keyPath: string): boolean {
    return fs.existsSync(certPath) && fs.existsSync(keyPath)
}

/**
 * Ensure certificate directory exists
 */
export async function ensureCertDirectory(certDir: string): Promise<void> {
    await fs.promises.mkdir(certDir, { recursive: true, mode: 0o700 })
}

/**
 * Get certificate info as string for logging
 */
export async function getCertificateInfoString(certPath: string): Promise<string> {
    try {
        const info = await loadCertificate(certPath)
        const expiryDays = await getCertificateExpiryDays(certPath)

        return `
Certificate Information:
  Common Name: ${info.subject.commonName}
  Organization: ${info.subject.organization || "N/A"}
  Valid From: ${info.validFrom.toISOString()}
  Valid To: ${info.validTo.toISOString()}
  Days Until Expiry: ${expiryDays}
  Fingerprint: ${info.fingerprint256}
  Serial Number: ${info.serialNumber}
`
    } catch (error) {
        return `Certificate info unavailable: ${error.message}`
    }
}
