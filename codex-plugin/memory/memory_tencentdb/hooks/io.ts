import path from "node:path";
import { pathToFileURL } from "node:url";

export async function readHookInput<T = unknown>(
  input: NodeJS.ReadableStream = process.stdin,
): Promise<T> {
  let raw = "";
  for await (const chunk of input) raw += chunk.toString();
  return JSON.parse(raw) as T;
}

export async function writeHookOutput(
  value: unknown,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function isMainModule(moduleUrl: string): boolean {
  if (!process.argv[1]) return false;
  return moduleUrl === pathToFileURL(path.resolve(process.argv[1])).href;
}
