import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const mode = process.argv[2];
assert.ok(["--verify-default", "--disable", "--verify-disabled"].includes(mode));
const baseUrl = process.env.IMMICH_SMOKE_URL || "http://127.0.0.1:2283";
assert.ok(process.env.IMMICH_SMOKE_STATE_PATH);
const state = JSON.parse(await readFile(process.env.IMMICH_SMOKE_STATE_PATH, "utf8"));

async function configRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}/api/admin/config${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.adminToken}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `Configuration request failed: ${response.status}`);
  return response.json();
}

if (mode === "--verify-default") {
  const defaults = await configRequest("/defaults");
  const config = await configRequest("");
  assert.equal(defaults.image.rawCompanions, true);
  assert.equal(config.image.rawCompanions, true);
  console.log("Normal image configuration enables RAW companion stacking by default");
}

if (mode === "--disable") {
  const config = await configRequest("");
  config.image.rawCompanions = false;
  await configRequest("", { method: "PUT", body: JSON.stringify(config) });
  const updated = await configRequest("");
  assert.equal(updated.image.rawCompanions, false);
  console.log("RAW companion stacking disabled through the normal configuration API");
}

if (mode === "--verify-disabled") {
  const config = await configRequest("");
  assert.equal(config.image.rawCompanions, false);
  console.log("Disabled RAW companion setting persists after server restart");
}
