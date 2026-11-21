import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "**/.next/",
      "**/out/",
      "**/dist/",
      "**/build/",
      "**/coverage/",
      "**/playwright-report/",
      "**/test-results/",
      "**/next-env.d.ts",
      ".superpowers/",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
