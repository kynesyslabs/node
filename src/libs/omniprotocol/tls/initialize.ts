import * as path from "path"
import log from "src/utilities/logger"
import {
    generateSelfSignedCert,
    certificateExists,
    ensureCertDirectory,
    verifyCertificateValidity,
    getCertificateExpiryDays,
    getCertificateInfoString,
} from "./certificates"

export interface TLSInitResult {
    certPath: string
    keyPath: string
    certDir: string
}

/**
 * Initialize TLS certificates for the node
 * - Creates cert directory if needed
 * - Generates self-signed cert if doesn't exist
 * - Validates existing certificates
 * - Warns about expiring certificates
 */
export async function initializeTLSCertificates(
    certDir?: string,
): Promise<TLSInitResult> {
    // Default cert directory
    const defaultCertDir = path.join(process.cwd(), "certs")
    const actualCertDir = certDir || defaultCertDir

    const certPath = path.join(actualCertDir, "node-cert.pem")
    const keyPath = path.join(actualCertDir, "node-key.pem")

    log.info(`[TLS] Initializing certificates in ${actualCertDir}`)

    // Ensure directory exists
    await ensureCertDirectory(actualCertDir)

    // Check if certificates exist
    if (certificateExists(certPath, keyPath)) {
        log.info("[TLS] Found existing certificates")

        // Verify validity
        const isValid = await verifyCertificateValidity(certPath)
        if (!isValid) {
            log.warning("[TLS] Existing certificate is invalid or expired")
            log.info("[TLS] Generating new certificate...")
            await generateSelfSignedCert(certPath, keyPath)
        } else {
            // Check expiry
            const expiryDays = await getCertificateExpiryDays(certPath)
            if (expiryDays < 30) {
                log.warning(
                    `[TLS] Certificate expires in ${expiryDays} days - consider renewal`,
                )
            } else {
                log.info(`[TLS] Certificate valid for ${expiryDays} more days`)
            }

            // Log certificate info
            const certInfo = await getCertificateInfoString(certPath)
            log.debug(certInfo)
        }
    } else {
        // Generate new certificate
        log.info("[TLS] No existing certificates found, generating new ones...")
        await generateSelfSignedCert(certPath, keyPath, {
            commonName: `omni-node-${Date.now()}`,
            validityDays: 365,
        })

        // Log certificate info
        const certInfo = await getCertificateInfoString(certPath)
        log.debug(certInfo)
    }

    log.info("[TLS] Certificates initialized successfully")

    return {
        certPath,
        keyPath,
        certDir: actualCertDir,
    }
}

/**
 * Get default TLS paths
 */
export function getDefaultTLSPaths(): { certPath: string; keyPath: string; certDir: string } {
    const certDir = path.join(process.cwd(), "certs")
    return {
        certDir,
        certPath: path.join(certDir, "node-cert.pem"),
        keyPath: path.join(certDir, "node-key.pem"),
    }
}
