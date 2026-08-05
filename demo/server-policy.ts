import { fileURLToPath } from "node:url";

export function demoDistPath(moduleUrl: string): string {
  return fileURLToPath(new URL("./dist/", moduleUrl));
}
