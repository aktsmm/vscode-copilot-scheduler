/**
 * A small WebSocket client that runs over a `net` socket (a named pipe or unix
 * socket). It exists because the extension host replaces `http.request`, which the
 * `ws` package would use for its handshake, and that replacement ignores the
 * custom socket. Only what the Agent Host needs is implemented: text messages,
 * ping/pong and close.
 */

import * as crypto from "crypto";
import * as net from "net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export function encodeClientFrame(
  opcode: number,
  payload: Buffer,
  maskKey: Buffer = crypto.randomBytes(4),
): Buffer {
  const length = payload.length;
  const header: number[] = [0x80 | opcode];
  if (length < 126) {
    header.push(0x80 | length);
  } else if (length < 65536) {
    header.push(0x80 | 126, length >> 8, length & 0xff);
  } else {
    const extended = Buffer.alloc(8);
    extended.writeBigUInt64BE(BigInt(length));
    header.push(0x80 | 127, ...extended);
  }
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    masked[i] = payload[i] ^ maskKey[i % 4];
  }
  return Buffer.concat([Buffer.from(header), maskKey, masked]);
}

interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Reads server frames (never masked) from a growing buffer. */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      const frame = this.readFrame();
      if (!frame) {
        return frames;
      }
      frames.push(frame);
    }
  }

  private readFrame(): Frame | undefined {
    const buf = this.buffer;
    if (buf.length < 2) {
      return undefined;
    }
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) {
        return undefined;
      }
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) {
        return undefined;
      }
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE_BYTES)) {
        throw new Error("WebSocket frame is too large");
      }
      length = Number(big);
      offset = 10;
    }
    if (length > MAX_MESSAGE_BYTES) {
      throw new Error("WebSocket frame is too large");
    }
    const maskKey = masked ? buf.subarray(offset, offset + 4) : undefined;
    if (masked) {
      offset += 4;
    }
    if (buf.length < offset + length) {
      return undefined;
    }
    const payload = Buffer.from(buf.subarray(offset, offset + length));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }
    this.buffer = buf.subarray(offset + length);
    return { fin, opcode, payload };
  }
}

export class PipeWebSocket {
  private readonly parser = new FrameParser();
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private messageHandler: (text: string) => void = () => undefined;
  private closeHandler: () => void = () => undefined;
  private closed = false;

  private constructor(private readonly socket: net.Socket) {}

  /** Connects, performs the HTTP upgrade and resolves once the server accepts it. */
  static connect(
    socketPath: string,
    requestPath: string,
    timeoutMs: number,
  ): Promise<PipeWebSocket> {
    return new Promise<PipeWebSocket>((resolve, reject) => {
      const socket = net.connect(socketPath);
      const key = crypto.randomBytes(16).toString("base64");
      let received = Buffer.alloc(0);
      let settled = false;

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error("WebSocket handshake timed out")),
        timeoutMs,
      );

      socket.once("error", fail);
      socket.once("close", () => fail(new Error("Socket closed during handshake")));
      socket.once("connect", () => {
        socket.write(
          [
            `GET ${requestPath} HTTP/1.1`,
            "Host: localhost",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        );
      });

      const onData = (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        const end = received.indexOf("\r\n\r\n");
        if (end < 0) {
          if (received.length > MAX_HEADER_BYTES) {
            fail(new Error("WebSocket handshake response is too large"));
          }
          return;
        }
        socket.off("data", onData);
        const head = received.subarray(0, end).toString("latin1");
        const accept = crypto
          .createHash("sha1")
          .update(key + GUID)
          .digest("base64");
        const lines = head.split("\r\n");
        const headers = new Map<string, string>();
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(":");
          if (colon > 0) {
            headers.set(
              line.slice(0, colon).trim().toLowerCase(),
              line.slice(colon + 1).trim(),
            );
          }
        }
        if (
          !/^HTTP\/1\.1 101\b/.test(lines[0] ?? "") ||
          headers.get("sec-websocket-accept") !== accept
        ) {
          fail(new Error("WebSocket handshake was refused"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners("error");
        socket.removeAllListeners("close");
        const client = new PipeWebSocket(socket);
        client.attach(received.subarray(end + 4));
        resolve(client);
      };
      socket.on("data", onData);
    });
  }

  onMessage(handler: (text: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  send(text: string): void {
    if (!this.closed) {
      this.socket.write(encodeClientFrame(OP_TEXT, Buffer.from(text, "utf8")));
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    try {
      this.socket.write(encodeClientFrame(OP_CLOSE, Buffer.alloc(0)));
    } catch {
      // the socket is already gone
    }
    this.socket.destroy();
    this.markClosed();
  }

  private attach(initial: Buffer): void {
    this.socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    this.socket.on("error", () => this.markClosed());
    this.socket.on("close", () => this.markClosed());
    if (initial.length > 0) {
      // Frames that arrived with the upgrade response are delivered after the
      // caller has installed its handlers, so none of them is lost.
      setImmediate(() => this.handleData(initial));
    }
  }

  private handleData(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.parser.push(chunk);
    } catch {
      this.close();
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === OP_PING) {
        this.socket.write(encodeClientFrame(OP_PONG, frame.payload));
      } else if (frame.opcode === OP_CLOSE) {
        this.close();
        return;
      } else if (
        frame.opcode === OP_TEXT ||
        frame.opcode === OP_BINARY ||
        frame.opcode === OP_CONTINUATION
      ) {
        this.fragmentBytes += frame.payload.length;
        if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
          this.close();
          return;
        }
        this.fragments.push(frame.payload);
        if (frame.fin) {
          const text = Buffer.concat(this.fragments).toString("utf8");
          this.fragments = [];
          this.fragmentBytes = 0;
          this.messageHandler(text);
        }
      }
    }
  }

  private markClosed(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeHandler();
  }
}
