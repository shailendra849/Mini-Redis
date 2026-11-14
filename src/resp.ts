export type ParseResult =
  | { status: "incomplete" }
  | { status: "invalid"; consumed: number; message: string }
  | { status: "complete"; consumed: number; args: string[] };

/** Parse one RESP array of bulk strings, or one legacy inline command. */
export function parseCommand(input: Buffer): ParseResult {
  if (input.length === 0) return { status: "incomplete" };

  if (input[0] !== 0x2a) {
    const lineEnd = input.indexOf("\r\n");
    if (lineEnd === -1) return { status: "incomplete" };
    const line = input.toString("utf8", 0, lineEnd).trim();
    return {
      status: "complete",
      consumed: lineEnd + 2,
      args: line.length === 0 ? [] : line.split(/\s+/),
    };
  }

  const arrayHeaderEnd = input.indexOf("\r\n");
  if (arrayHeaderEnd === -1) return { status: "incomplete" };
  const countText = input.toString("ascii", 1, arrayHeaderEnd);
  if (!/^\d+$/.test(countText)) {
    return { status: "invalid", consumed: arrayHeaderEnd + 2, message: "invalid array length" };
  }

  const count = Number(countText);
  if (!Number.isSafeInteger(count) || count > 100_000) {
    return { status: "invalid", consumed: arrayHeaderEnd + 2, message: "array is too large" };
  }

  const args: string[] = [];
  let offset = arrayHeaderEnd + 2;

  for (let index = 0; index < count; index += 1) {
    if (offset >= input.length) return { status: "incomplete" };
    if (input[offset] !== 0x24) {
      return { status: "invalid", consumed: offset + 1, message: "expected bulk string" };
    }

    const bulkHeaderEnd = input.indexOf("\r\n", offset);
    if (bulkHeaderEnd === -1) return { status: "incomplete" };
    const lengthText = input.toString("ascii", offset + 1, bulkHeaderEnd);
    if (!/^\d+$/.test(lengthText)) {
      return { status: "invalid", consumed: bulkHeaderEnd + 2, message: "invalid bulk string length" };
    }

    const byteLength = Number(lengthText);
    if (!Number.isSafeInteger(byteLength) || byteLength > 512 * 1024 * 1024) {
      return { status: "invalid", consumed: bulkHeaderEnd + 2, message: "bulk string is too large" };
    }

    const valueStart = bulkHeaderEnd + 2;
    const valueEnd = valueStart + byteLength;
    if (input.length < valueEnd + 2) return { status: "incomplete" };
    if (input[valueEnd] !== 0x0d || input[valueEnd + 1] !== 0x0a) {
      return { status: "invalid", consumed: valueEnd + 2, message: "bulk string missing CRLF" };
    }

    args.push(input.toString("utf8", valueStart, valueEnd));
    offset = valueEnd + 2;
  }

  return { status: "complete", consumed: offset, args };
}

export function encodeBulkString(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from(`$${body.length}\r\n`), body, Buffer.from("\r\n")]);
}

export function encodeSimpleString(value: string): Buffer {
  return Buffer.from(`+${value}\r\n`);
}

export function encodeInteger(value: number): Buffer {
  return Buffer.from(`:${value}\r\n`);
}

export function encodeError(message: string): Buffer {
  return Buffer.from(`-ERR ${message.replace(/[\r\n]/g, " ")}\r\n`);
}

export function encodeNullBulk(): Buffer {
  return Buffer.from("$-1\r\n");
}

export function encodeArray(args: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) parts.push(encodeBulkString(arg));
  return Buffer.concat(parts);
}
