import net from "node:net";
import { encodeArray } from "../src/resp.js";

/** True when `buf` holds one full simple/error/integer/bulk RESP reply. */
export function isCompleteReply(buf: Buffer): boolean {
  if (buf.length < 3) return false;
  const type = buf[0];
  if (type === 0x2b || type === 0x2d || type === 0x3a) {
    return buf.indexOf("\r\n") !== -1;
  }
  if (type === 0x24) {
    const headerEnd = buf.indexOf("\r\n");
    if (headerEnd === -1) return false;
    const length = Number(buf.toString("ascii", 1, headerEnd));
    if (!Number.isFinite(length)) return false;
    if (length < 0) return buf.length >= headerEnd + 2;
    return buf.length >= headerEnd + 2 + length + 2;
  }
  return false;
}

export async function sendRaw(port: number, payload: Buffer, host = "127.0.0.1"): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = net.connect({ port, host }, () => socket.write(payload));
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out waiting for reply; got ${JSON.stringify(buf.toString("utf8"))}`));
    }, 5_000);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (isCompleteReply(buf)) {
        clearTimeout(timer);
        socket.end();
        resolve(buf.toString("utf8"));
      }
    });
    socket.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
  });
}

export async function sendCommand(port: number, args: string[], host = "127.0.0.1"): Promise<string> {
  return sendRaw(port, encodeArray(args), host);
}
