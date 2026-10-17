/** Where the SDK's own diagnostics go. Pass `logger` to `init()` to route them elsewhere. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

let debugForced = false;

/** `init({ debug: true })` / `dryRun` turn on debug output without the environment variable. */
export function setDebug(on: boolean): void {
  debugForced = on;
}

export const envFlag = (name: string): boolean => /^(1|true|yes)$/i.test(env(name) ?? "");

export const debugEnabled = (): boolean => debugForced || envFlag("AIKRAFT_DEBUG");

export const consoleLogger: Logger = {
  debug: (message, ...args) => {
    if (debugEnabled()) console.debug(message, ...args);
  },
  warn: (message, ...args) => console.warn(message, ...args),
  error: (message, ...args) => console.error(message, ...args),
};

export let logger: Logger = consoleLogger;

export function setLogger(next: Logger): void {
  logger = next;
}

export function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}
