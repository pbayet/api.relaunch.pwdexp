import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    clearMocks: true,
    env: {
      NODE_ENV: "test",
      API_KEY: "test-api-key",
      BASE_RECIPIENT_EMAIL: "qa@example.com",
      PWD_REMINDER_TIERS: "15,7,1",
    },
  },
});
