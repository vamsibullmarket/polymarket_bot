import { appendFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";

export type LogColor = "green" | "yellow" | "red" | "cyan" | "magenta" | "dim";

const ANSI: Record<LogColor, string> = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  dim: "\x1b[2m",
};
const RESET = "\x1b[0m";

function nowIso(): string {
  return new Date().toISOString();
}

class Log {
  private readonly _filePath: string;
  private _buffer: string[] = [];

  constructor() {
    mkdirSync("logs", { recursive: true });
    const tag = new Date()
      .toISOString()
      .replace("T", "-")
      .replace(/:/g, "-")
      .slice(0, 19);
    this._filePath = join("logs", `early-bird-${tag}.log`);
    this._pruneOldLogs();
  }

  /** Keep only the 20 most recent log files, delete the rest. */
  private _pruneOldLogs(): void {
    try {
      const dir = "logs";
      const files = readdirSync(dir)
        .filter((f) => f.startsWith("early-bird-") && f.endsWith(".log"))
        .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      for (const file of files.slice(20)) {
        unlinkSync(join(dir, file.name));
      }
    } catch {
      // Non-fatal — log pruning is best-effort
    }
  }

  write(msg: string, color?: LogColor): void {
    const plain = `[${nowIso()}] ${msg}`;
    const console_line = color ? `${ANSI[color]}${plain}${RESET}` : plain;
    console.log(console_line);
    this._buffer.push(plain + "\n");
  }

  flush(): void {
    if (this._buffer.length === 0) return;
    mkdirSync("logs", { recursive: true });
    appendFileSync(this._filePath, this._buffer.join(""), "utf8");
    this._buffer = [];
  }
}

export const log = new Log();

const MARKET_LOG_DIR = "logs/markets";
const MAX_MARKET_LOGS = 10;

export class MarketLog {
  private readonly _path: string;
  private _buf: string[] = [];
  private _timer: ReturnType<typeof setInterval>;

  constructor(slug: string) {
    mkdirSync(MARKET_LOG_DIR, { recursive: true });
    this._path = join(MARKET_LOG_DIR, `${slug}.log`);
    this._pruneOld();
    this._timer = setInterval(() => this._flush(), 1000);
  }

  private _pruneOld(): void {
    try {
      const files = readdirSync(MARKET_LOG_DIR)
        .filter((f) => f.endsWith(".log"))
        .map((f) => ({ name: f, mtime: statSync(join(MARKET_LOG_DIR, f)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime); // oldest first
      for (const f of files.slice(0, Math.max(0, files.length - MAX_MARKET_LOGS + 1))) {
        unlinkSync(join(MARKET_LOG_DIR, f.name));
      }
    } catch {}
  }

  write(msg: string): void {
    this._buf.push(`[${new Date().toISOString()}] ${msg}\n`);
  }

  private _flush(): void {
    if (this._buf.length === 0) return;
    appendFileSync(this._path, this._buf.join(""), "utf8");
    this._buf = [];
  }

  done(): void {
    clearInterval(this._timer);
    this._flush();
    appendFileSync(this._path, `[${new Date().toISOString()}] [MARKET_COMPLETE]\n`, "utf8");
  }
}
