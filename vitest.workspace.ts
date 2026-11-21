import { configDefaults, defineConfig } from "vitest/config";

const integrationTests = ["**/*.integration.test.ts", "**/real-router-contract.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          exclude: [...configDefaults.exclude, ...integrationTests, "**/e2e/**", "**/.superpowers/**"],
        },
      },
      {
        test: {
          name: "integration",
          include: integrationTests,
          exclude: [...configDefaults.exclude, "**/.superpowers/**"],
        },
      },
    ],
  },
});
