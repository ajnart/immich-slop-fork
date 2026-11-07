import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

const baseUrl = process.env.IMMICH_SMOKE_URL || "http://127.0.0.1:2283";
const statePath = process.env.IMMICH_SMOKE_STATE_PATH;
const disabled = process.argv.includes("--disabled");
const sourcePath = resolve(
  process.env.IMMICH_SMOKE_RAW_PATH ||
    "e2e/test-assets/formats/raw/Fujifilm/X100V_compressed.RAF",
);
const temporaryPath = await mkdtemp(join(tmpdir(), "immich-companions-"));
const password = `Smoke-${randomUUID()}!`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function request(path, { token, body, method = "GET" } = {}) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api${path}`, {
    headers,
    method,
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `${method} ${path}: ${response.status} ${await response.text()}`,
    );
  }
  return response;
}

async function json(path, options) {
  return (await request(path, options)).json();
}

async function waitFor(description, check) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await setTimeout(1000);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function upload(token, bytes, filename) {
  const form = new FormData();
  form.set("assetData", new File([bytes], filename));
  form.set("fileCreatedAt", "2026-01-02T03:04:05.000Z");
  form.set("fileModifiedAt", "2026-01-02T03:04:05.000Z");
  const result = await json("/assets", { token, method: "POST", body: form });
  assert.equal(
    result.status,
    "created",
    `Unexpected upload status for ${filename}`,
  );
  return result.id;
}

async function metadataReady(token, id) {
  await waitFor(`capture metadata on ${id}`, async () => {
    const asset = await json(`/assets/${id}`, { token });
    return (
      asset.exifInfo?.dateTimeOriginal &&
      asset.exifInfo?.make &&
      asset.exifInfo?.model
    );
  });
}

async function verifyOriginal(token, id, expectedDigest) {
  const response = await request(`/assets/${id}/original`, { token });
  assert.equal(
    digest(Buffer.from(await response.arrayBuffer())),
    expectedDigest,
    `Original changed for ${id}`,
  );
}

async function verifyThumbnail(token, id) {
  await waitFor(`thumbnail on ${id}`, async () => {
    const response = await fetch(
      `${baseUrl}/api/assets/${id}/thumbnail?size=thumbnail`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = await response.arrayBuffer();
    return (
      response.ok &&
      response.headers.get("content-type")?.startsWith("image/") &&
      body.byteLength > 0
    );
  });
}

async function waitForProcessing(token) {
  let idleChecks = 0;
  await waitFor(
    "metadata, thumbnails, and file cleanup to finish",
    async () => {
      const queues = await json("/queues", { token });
      for (const name of [
        "metadataExtraction",
        "thumbnailGeneration",
        "backgroundTask",
      ]) {
        const queue = queues.find((queue) => queue.name === name);
        assert.ok(queue, `Missing queue ${name}`);
        assert.equal(queue.isPaused, false, `Queue ${name} is paused`);
        const { active, waiting, delayed, paused, failed } = queue.statistics;
        assert.equal(failed, 0, `Queue ${name} has failed jobs`);
        if (active + waiting + delayed + paused > 0) {
          idleChecks = 0;
          return false;
        }
      }
      idleChecks++;
      return idleChecks >= 2;
    },
  );
}

async function verifyPair(token, ids) {
  await waitFor("rendered-primary pair", async () => {
    const stacks = await json(`/stacks?primaryAssetId=${ids.rendered}`, {
      token,
    });
    return (
      stacks.length === 1 &&
      stacks[0].primaryAssetId === ids.rendered &&
      stacks[0].assets.length === 2 &&
      stacks[0].assets[0].id === ids.rendered &&
      stacks[0].assets.some((asset) => asset.id === ids.raw)
    );
  });
}

try {
  const rawBytes = await readFile(sourcePath);
  assert.equal(
    rawBytes.subarray(0, 16).toString(),
    "FUJIFILMCCD-RAW ",
    "Expected genuine RAF bytes",
  );
  let jpegBytes;
  for (const tag of ["PreviewImage", "JpgFromRaw"]) {
    const bytes = execFileSync("exiftool", ["-b", `-${tag}`, sourcePath], {
      maxBuffer: 32 * 1024 * 1024,
    });
    if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      jpegBytes = bytes;
      break;
    }
  }
  assert.ok(jpegBytes, "RAF fixture has no embedded JPEG");
  const jpegPath = join(temporaryPath, "DSC0001.JPG");
  await writeFile(jpegPath, jpegBytes);
  execFileSync("exiftool", [
    "-overwrite_original",
    "-TagsFromFile",
    sourcePath,
    "-Make",
    "-Model",
    "-DateTimeOriginal",
    "-SubSecTimeOriginal",
    "-OffsetTimeOriginal",
    jpegPath,
  ]);
  jpegBytes = await readFile(jpegPath);
  const checksums = { raw: digest(rawBytes), rendered: digest(jpegBytes) };
  const files = {
    raw: { bytes: rawBytes, filename: "DSC0001.RAF" },
    rendered: { bytes: jpegBytes, filename: "DSC0001.JPG" },
  };
  if (disabled) {
    assert.ok(statePath, "IMMICH_SMOKE_STATE_PATH is required for --disabled");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    for (const asset of state.assets) {
      await verifyOriginal(asset.token, asset.id, asset.checksum);
      await verifyThumbnail(asset.token, asset.id);
    }
    await verifyPair(state.pair.token, state.pair.ids);
    const user = {
      email: "disabled@example.test",
      name: "Disabled companion smoke",
      password,
    };
    await json("/admin/users", {
      token: state.adminToken,
      method: "POST",
      body: user,
    });
    const { accessToken: token } = await json("/auth/login", {
      method: "POST",
      body: { email: user.email, password },
    });
    for (const kind of ["raw", "rendered"]) {
      const id = await upload(token, files[kind].bytes, files[kind].filename);
      await metadataReady(token, id);
      await verifyOriginal(token, id, checksums[kind]);
      await verifyThumbnail(token, id);
    }
    await waitForProcessing(state.adminToken);
    assert.deepEqual(
      await json("/stacks", { token }),
      [],
      "Disabled imports must remain unstacked",
    );
    console.log(
      "Feature disabled: existing pair and original downloads survive; new RAW/JPEG imports remain unstacked",
    );
  } else {
    const admin = {
      email: "raw-first@example.test",
      name: "RAW first smoke",
      password,
    };
    await json("/auth/admin-sign-up", { method: "POST", body: admin });
    const firstSession = await json("/auth/login", {
      method: "POST",
      body: { email: admin.email, password },
    });
    const second = {
      email: "jpeg-first@example.test",
      name: "JPEG first smoke",
      password,
    };
    await json("/admin/users", {
      token: firstSession.accessToken,
      method: "POST",
      body: second,
    });
    const secondSession = await json("/auth/login", {
      method: "POST",
      body: { email: second.email, password },
    });
    const cases = [
      {
        name: "RAW first",
        token: firstSession.accessToken,
        order: ["raw", "rendered"],
      },
      {
        name: "JPEG first",
        token: secondSession.accessToken,
        order: ["rendered", "raw"],
      },
    ];
    const uploaded = [];
    for (const test of cases) {
      const ids = {};
      for (const kind of test.order) {
        ids[kind] = await upload(
          test.token,
          files[kind].bytes,
          files[kind].filename,
        );
        await metadataReady(test.token, ids[kind]);
        await verifyThumbnail(test.token, ids[kind]);
        await waitForProcessing(firstSession.accessToken);
      }
      await verifyPair(test.token, ids);
      await verifyOriginal(test.token, ids.raw, checksums.raw);
      await verifyOriginal(test.token, ids.rendered, checksums.rendered);
      await verifyThumbnail(test.token, ids.raw);
      await verifyThumbnail(test.token, ids.rendered);
      uploaded.push({ ...test, ids });
      console.log(
        `${test.name}: rendered primary, both originals unchanged, both thumbnails available`,
      );
    }
    await waitForProcessing(firstSession.accessToken);
    const first = uploaded[0];
    await request("/assets", {
      token: first.token,
      method: "DELETE",
      body: { ids: [first.ids.rendered], force: true },
    });
    await waitFor("rendered original deletion", async () => {
      const response = await fetch(
        `${baseUrl}/api/assets/${first.ids.rendered}`,
        {
          headers: { Authorization: `Bearer ${first.token}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      await response.arrayBuffer();
      return response.status === 400 || response.status === 404;
    });
    await waitForProcessing(firstSession.accessToken);
    assert.deepEqual(
      await json("/stacks", { token: first.token }),
      [],
      "Deleting JPEG must dissolve its pair",
    );
    await verifyOriginal(first.token, first.ids.raw, checksums.raw);
    await verifyThumbnail(first.token, first.ids.raw);
    console.log(
      "Rendered deletion: RAW original unchanged and independently owned thumbnail remains available",
    );
    if (statePath) {
      const remaining = uploaded[1];
      const state = {
        adminToken: firstSession.accessToken,
        adminBrowser: {
          email: admin.email,
          password,
          userId: firstSession.userId,
        },
        pair: { token: remaining.token, ids: remaining.ids },
        browser: {
          email: second.email,
          password,
          userId: secondSession.userId,
        },
        assets: [
          { token: first.token, id: first.ids.raw, checksum: checksums.raw },
          {
            token: remaining.token,
            id: remaining.ids.raw,
            checksum: checksums.raw,
          },
          {
            token: remaining.token,
            id: remaining.ids.rendered,
            checksum: checksums.rendered,
          },
        ],
      };
      await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
    }
  }
} finally {
  await rm(temporaryPath, { recursive: true, force: true });
}
