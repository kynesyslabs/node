import fs from "fs"

export interface fileChunk {
    index: number
    startbyte: number
    endbyte: number
    size: number
    filepath: string
    content: any
    info: string
}

async function readFileChunk(
    startbyte: number,
    size: number,
    filehandle: fs.promises.FileHandle,
): Promise<[boolean, Buffer, string]> {
    // Allocating a buffer of 'size' bytes
    const buffer = Buffer.alloc(size)
    var result = false
    var message = ""

    // NOTE Checking if the file is smaller than the endbyte
    if (startbyte + size > (await filehandle.stat()).size) {
        // If it is, we set the size to the remaining bytes
        size = (await filehandle.stat()).size - startbyte
        // And we set the message to 'EOF'
        message = "EOF"
    }
    // Reading the file from 'startbyte' to 'startbyte + size' and storing it in the buffer
    await filehandle.read(buffer, 0, size, startbyte)
    // Returning the buffer
    return [result, buffer, message]
}

// INFO Getting a specific chunk of a file
export async function fileGetChunkAt(
    chunk_index: number,
    chunkSize: number,
    filepath: string,
): Promise<fileChunk> {
    // Opening the file
    const filehandle = await fs.promises.open(filepath, "r")
    // Getting the startbyte
    const startbyte = chunk_index * chunkSize
    // Getting the size
    var size = chunkSize
    var response = await readFileChunk(startbyte, size, filehandle)
    // Creating the chunk
    const chunk: fileChunk = {
        index: chunk_index,
        startbyte: startbyte,
        endbyte: startbyte + size,
        size: size,
        filepath: filepath,
        content: response[1],
        info: response[2],
    }
    // Closing the file
    await filehandle.close()
    // Returning the chunk
    return chunk
}

// INFO Splitting a file into chunks of a certain size
export async function fileSplit(
    filepath: string,
    chunkSize: number,
): Promise<fileChunk[]> {
    // Creating an empty array of chunks
    var chunksArray: fileChunk[] = []
    // Creating the first chunk
    const firstChunk: fileChunk = {
        index: 0,
        startbyte: 0,
        endbyte: chunkSize,
        size: chunkSize,
        filepath: filepath,
        content: false,
        info: "",
    }
    // NOTE Checking if the file exists
    if (!fs.existsSync(filepath)) {
        // If it doesn't, we set the info to 'ENOENT'
        firstChunk.info = "ENOENT"
        return [firstChunk]
    }
    // Opening the file
    const filehandle = await fs.promises.open(filepath, "r")
    // Getting the file size
    const fileSize = (await filehandle.stat()).size
    // Calculating the number of chunks
    const numChunks = Math.ceil(fileSize / chunkSize)
    // Looping through the number of chunks
    for (let i = 0; i < numChunks; i++) {
        var chunkResponse = await readFileChunk(
            i * chunkSize,
            chunkSize,
            filehandle,
        )
        const chunk: fileChunk = {
            index: i,
            startbyte: i * chunkSize,
            endbyte: i * chunkSize + chunkSize,
            size: chunkSize,
            filepath: filepath,
            content: chunkResponse[1],
            info: chunkResponse[2],
        }
        // Pushing the promise to the array
        chunksArray.push(chunk)
        // If we get errors, we break the loop
        if (chunkResponse[0]) {
            break
        }
    }
    // Closing the file
    await filehandle.close()
    // Returning the chunks
    return chunksArray
}

// INFO Recombining a chunked file
export async function fileJoin(
    chunks: fileChunk[],
    filepath: string,
): Promise<void> {
    // Creating a write stream
    const writeStream = fs.createWriteStream(filepath)
    // Looping through the chunks
    for (const chunk of chunks) {
        // Writing the chunk to the file
        writeStream.write(chunk.content)
    }
    // Ending the write stream
    writeStream.end()
    // Returning the promise
    return new Promise((resolve, reject) => {
        writeStream.on("finish", resolve)
        writeStream.on("error", reject)
    })
}
