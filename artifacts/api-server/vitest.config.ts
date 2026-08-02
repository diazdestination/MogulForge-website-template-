import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./vitest.globalSetup.ts",
    // Confirmation/reminder tests send real email when the Gmail connector
    // is configured in the workspace; those network sends can exceed the 5s
    // default and flake.
    testTimeout: 20_000,
  },
});
