import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("grants native screensaver windows access to the event bridge", () => {
  // Browser mocks bypass this boundary: keep the native capability in the regression suite.
  const capability = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/screensaver.json", import.meta.url), "utf8"));
  expect(capability.windows).toContain("screensaver-*");
  expect(capability.permissions).toContain("core:event:default");
});
