import { parseArgs, type ParseArgsConfig } from "node:util";
import { UsageError } from "./io.js";

type Options = NonNullable<ParseArgsConfig["options"]>;

/** node:util parseArgs with positionals allowed and errors turned into UsageError. */
export function parse<O extends Options>(argv: string[], options: O) {
  try {
    return parseArgs({ args: argv, options: { ...options, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}
