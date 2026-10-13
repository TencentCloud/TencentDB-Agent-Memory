import { defineConfig } from "@kubb/core";
import { pluginOas } from "@kubb/plugin-oas";
import { pluginTs } from "@kubb/plugin-ts";
import { pluginZod } from "@kubb/plugin-zod";

// The standalone Knowledge API is the authoritative public Wiki/CodeGraph contract.
export default defineConfig({
  root: ".",
  input: { path: "../MemoryKnowledge/openapi.yaml" },
  output: { path: "./src/gateway/generated/knowledge", clean: false, barrelType: false },
  plugins: [
    pluginOas({ generators: [] }),
    pluginTs({ output: { path: "./types.ts", barrelType: false } }),
    pluginZod({ output: { path: "./schemas.ts", barrelType: false }, typed: false, importPath: "zod" }),
  ],
});
