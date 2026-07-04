import { decode, encode, type ClientMessage, type ServerMessage } from "@mmo/shared";

type Handler<T extends ServerMessage["t"]> = (msg: Extract<ServerMessage, { t: T }>) => void;

export class Connection {
  private ws: WebSocket;
  private handlers = new Map<string, (msg: ServerMessage) => void>();
  readonly ready: Promise<void>;
  onClose: (() => void) | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error("connection failed")));
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = decode<ServerMessage>(String(ev.data));
      if (msg) this.handlers.get(msg.t)?.(msg);
    });
    this.ws.addEventListener("close", () => this.onClose?.());
  }

  on<T extends ServerMessage["t"]>(t: T, fn: Handler<T>): void {
    this.handlers.set(t, fn as (msg: ServerMessage) => void);
  }

  send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }
}
