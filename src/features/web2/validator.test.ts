/**
 * The DAHR URL check refuses IP literals outside public unicast space,
 * whatever form the URL writes them in, and does not refuse a host name for
 * how it is spelled.
 */

import { describe, expect, it } from "bun:test"
import { validateAndNormalizeHttpUrl } from "./validator"

const refused = (url: string) => validateAndNormalizeHttpUrl(url).ok === false

describe("validateAndNormalizeHttpUrl", () => {
    it("refuses bracketed IPv6 literals that are not public", () => {
        for (const url of [
            "http://[::1]/",
            "http://[::]/",
            "https://[fe80::1]/",
            "https://[fd00::1]:8443/x",
            "https://[fc00::5]/",
            "https://[ff02::1]/",
            "https://[::ffff:127.0.0.1]/",
            "https://[::ffff:10.0.0.1]/",
            "https://[::ffff:169.254.169.254]/",
            "https://[64:ff9b::a00:1]/",
            "https://[2002:a00:1::]/",
        ]) {
            expect([url, refused(url)]).toEqual([url, true])
        }
    })

    it("refuses private IPv4 in every form the URL parser accepts", () => {
        for (const url of [
            "http://127.0.0.1/",
            "http://2130706433/",
            "http://0x7f.1/",
            "http://10.1.2.3/",
            "http://172.20.0.1/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data",
            "http://100.64.0.1/",
            "http://0.0.0.0/",
            "http://224.0.0.1/",
        ]) {
            expect([url, refused(url)]).toEqual([url, true])
        }
    })

    it("accepts public IP literals, IPv6 included", () => {
        for (const url of ["https://8.8.8.8/", "https://[2606:4700:4700::1111]/dns-query"]) {
            expect([url, refused(url)]).toEqual([url, false])
        }
    })

    it("does not refuse host names that only look like IPv6 prefixes", () => {
        for (const url of [
            "https://ffmpeg.org/",
            "https://fcbarcelona.com/",
            "https://fd.example/",
            "https://fe80.example/",
        ]) {
            expect([url, refused(url)]).toEqual([url, false])
        }
    })

    it("still refuses localhost names, credentials and other schemes", () => {
        expect(refused("http://localhost/")).toBe(true)
        expect(refused("http://api.localhost/")).toBe(true)
        expect(refused("https://u:p@example.com/")).toBe(true)
        expect(refused("ftp://example.com/")).toBe(true)
    })

    it("canonicalizes the host, default port and fragment", () => {
        const r = validateAndNormalizeHttpUrl(" https://Example.COM:443/a#frag ")
        expect(r).toEqual({ ok: true, normalizedUrl: "https://example.com/a" })
    })
})
