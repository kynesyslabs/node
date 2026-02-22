import * as fs from "fs"

function padTo16(n: number) {
    const mod = n % 16
    return mod === 0 ? 0 : 16 - mod
}

function buildHeader(shape: [number, number]) {
    // NPY v1.0 header is a Python dict literal, padded with spaces and ending with newline.
    // We only support little-endian float32, C-order.
    const dict = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape[0]}, ${shape[1]}), }`
    return dict
}

export function writeNpyFloat32Matrix(args: {
    path: string
    rows: number
    cols: number
    data: Float32Array
}) {
    const { path, rows, cols, data } = args

    if (data.length !== rows * cols) {
        throw new Error(
            `NPY write error: data length ${data.length} != rows*cols ${rows * cols}`,
        )
    }

    const magic = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]) // \x93NUMPY
    const version = Buffer.from([0x01, 0x00]) // v1.0

    const headerText = buildHeader([rows, cols])
    // Header length counts the full header string including padding and trailing newline.
    // Total: magic(6) + ver(2) + headerLen(2) + headerBytes must be divisible by 16.
    const preludeLen = magic.length + version.length + 2
    const baseHeader = Buffer.from(headerText, "ascii")
    const baseLenWithoutNewline = baseHeader.length

    // We will add: spaces padding + '\n'
    const totalSoFar = preludeLen + baseLenWithoutNewline + 1
    const padSpaces = padTo16(totalSoFar)
    const headerBytes = Buffer.concat([
        baseHeader,
        Buffer.from(" ".repeat(padSpaces), "ascii"),
        Buffer.from("\n", "ascii"),
    ])

    const headerLen = Buffer.alloc(2)
    headerLen.writeUInt16LE(headerBytes.length, 0)

    const payload = Buffer.from(
        data.buffer,
        data.byteOffset,
        data.byteLength,
    )

    fs.writeFileSync(
        path,
        Buffer.concat([magic, version, headerLen, headerBytes, payload]),
    )
}

