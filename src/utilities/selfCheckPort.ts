import net from "net"
import { promisify } from "util"

export async function selfCheckPort(port: number, timeout = 2000): Promise<boolean> {
  const client = new net.Socket()
  const connectPromise = promisify(client.connect.bind(client))

  try {
    // Attempt to connect to the port from outside the local network
    await connectPromise(port, "8.8.8.8")
    return true
  } catch (error) {
    return false
  } finally {
    client.destroy()
  }
}
