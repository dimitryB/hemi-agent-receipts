/** Minimal leveled logger: one line per event, `key=value` context, nothing secret. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function format(context?: Record<string, unknown>): string {
  if (!context) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    const text =
      value instanceof Error
        ? (value.message.split("\n")[0] ?? "")
        : typeof value === "bigint"
          ? value.toString()
          : typeof value === "object"
            ? JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
            : String(value);
    parts.push(`${key}=${/\s/.test(text) ? JSON.stringify(text) : text}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export function createLogger(level: LogLevel = "info", sink: (line: string) => void = (line) => console.log(line)): Logger {
  const min = ORDER[level];
  const emit = (lvl: Exclude<LogLevel, "silent">) => (message: string, context?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    sink(`${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${message}${format(context)}`);
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export const silentLogger: Logger = createLogger("silent");

/** Short, single-line description of an error (viem errors are multi-line). */
export function errorText(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { shortMessage?: string; details?: string; message?: string };
    const head = e.shortMessage ?? e.message?.split("\n")[0] ?? String(error);
    return e.details && !head.includes(e.details) ? `${head} (${e.details})` : head;
  }
  return String(error);
}
