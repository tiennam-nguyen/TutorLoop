import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          exclude: [...configDefaults.exclude, "**/*.integration.test.ts", "**/e2e/**", "**/.superpowers/**"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["**/*.integration.test.ts"],
          exclude: [...configDefaults.exclude, "**/.superpowers/**"],
        },
      },
    ],
  },
});
