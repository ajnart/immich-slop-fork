import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const baseUrl = process.env.IMMICH_SMOKE_URL || "http://127.0.0.1:2283";
const output = resolve(process.env.IMMICH_DEMO_OUTPUT || "slop-fork-demo");
const state = JSON.parse(
  await readFile(process.env.IMMICH_SMOKE_STATE_PATH, "utf8"),
);
const session = `slop-demo-${process.env.GITHUB_RUN_ID || process.pid}`;
const checks = [];
let recording = false;
await mkdir(output, { recursive: true });

function browser(...args) {
  let result;
  try {
    result = execFileSync(
      "agent-browser",
      ["--session", session, "--json", ...args],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 90_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "45000" },
      },
    );
  } catch (error) {
    const detail = String(
      error.stdout || error.stderr || error.message,
    ).replaceAll(state.browser.password, "[REDACTED]");
    throw new Error(`agent-browser ${args[0]} failed: ${detail}`);
  }
  const response = JSON.parse(result);
  assert.equal(
    response.success,
    true,
    `agent-browser ${args[0]} did not succeed`,
  );
  return response.data;
}

async function api(path, token, body) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  await response.arrayBuffer();
  assert.equal(
    response.ok,
    true,
    `Demo account setup failed: ${response.status}`,
  );
}

async function snapshot(name) {
  const data = browser("snapshot");
  let text = JSON.stringify(data, null, 2);
  for (const secret of [
    state.adminToken,
    state.pair.token,
    state.browser.password,
  ]) {
    text = text.replaceAll(secret, "[REDACTED]");
  }
  await writeFile(join(output, `${name}.json`), text);
}

async function screenshot(name) {
  if (recording) {
    browser("wait", "1700");
  }
  const path = join(output, `${name}.png`);
  browser("screenshot", path);
  assert.ok((await stat(path)).size > 1000, `Empty screenshot ${name}`);
}

function waitForAsset(id) {
  browser("wait", "#immich-asset-viewer");
  browser(
    "wait",
    "--fn",
    `Array.from(document.querySelectorAll('#immich-asset-viewer img')).some(image => !image.closest('#stack-slideshow') && image.complete && image.naturalWidth > 0 && image.src.includes('${id}'))`,
  );
}

async function demonstrate(name, width, height) {
  browser("set", "viewport", String(width), String(height));
  browser("open", `${baseUrl}/photos`);
  browser("wait", `[data-asset="${state.pair.ids.rendered}"]`);
  browser(
    "wait",
    "--fn",
    `document.querySelector('[data-asset="${state.pair.ids.rendered}"] img')?.naturalWidth > 0`,
  );
  const timeline = browser(
    "eval",
    `Array.from(document.querySelectorAll('[data-asset]')).map(element => element.dataset.asset)`,
  ).result;
  assert.deepEqual(
    timeline,
    [state.pair.ids.rendered],
    `${name}: timeline must show one JPEG primary`,
  );
  const viewport = browser(
    "eval",
    "({ width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth })",
  ).result;
  assert.equal(viewport.width, width);
  assert.ok(
    viewport.documentWidth <= width,
    `${name}: timeline overflows viewport`,
  );
  browser(
    "record",
    "start",
    join(output, `${name}.mp4`),
    "--cursor",
    "--contact-sheet",
  );
  recording = true;
  await snapshot(`${name}-timeline`);
  await screenshot(`${name}-timeline`);
  browser("click", `[data-asset="${state.pair.ids.rendered}"]`);
  waitForAsset(state.pair.ids.rendered);
  browser("wait", "#stack-slideshow");
  browser(
    "wait",
    "--fn",
    "(() => { const images = Array.from(document.querySelectorAll('#stack-slideshow [data-asset] img')).filter(image => !image.src.startsWith('data:')); return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0) && !document.querySelector('#stack-slideshow [data-testid=thumbhash]'); })()",
  );
  const members = browser(
    "eval",
    "document.querySelectorAll('#stack-slideshow [data-asset]').length",
  ).result;
  assert.equal(members, 2, `${name}: stack must expose both files`);
  await screenshot(`${name}-jpeg-primary`);
  browser("find", "role", "button", "click", "--name", "Info", "--exact");
  browser("wait", "--text", "DSC0001.JPG");
  await snapshot(`${name}-jpeg-details`);
  await screenshot(`${name}-jpeg-details`);
  browser("find", "role", "button", "click", "--name", "Close", "--exact");
  browser("wait", "#detail-panel", "--state", "hidden");
  browser("click", `#stack-slideshow [data-asset="${state.pair.ids.raw}"]`);
  waitForAsset(state.pair.ids.raw);
  await screenshot(`${name}-raw-companion`);
  browser("find", "role", "button", "click", "--name", "Info", "--exact");
  browser("wait", "--text", "DSC0001.RAF");
  await snapshot(`${name}-raw-details`);
  await screenshot(`${name}-raw-details`);
  browser("find", "role", "button", "click", "--name", "Close", "--exact");
  browser("wait", "#detail-panel", "--state", "hidden");
  browser(
    "click",
    `#stack-slideshow [data-asset="${state.pair.ids.rendered}"]`,
  );
  waitForAsset(state.pair.ids.rendered);
  await screenshot(`${name}-back-to-jpeg`);
  browser("record", "stop");
  recording = false;
  const video = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_name,width,height",
        "-of",
        "json",
        join(output, `${name}.mp4`),
      ],
      { encoding: "utf8" },
    ),
  );
  assert.ok(Number(video.format.duration) > 0);
  assert.equal(video.streams[0].codec_name, "h264");
  assert.equal(video.streams[0].width, width);
  assert.equal(video.streams[0].height, height);
  checks.push({
    name,
    viewport,
    stackMembers: members,
    timelinePrimary: "DSC0001.JPG",
    selectedCompanion: "DSC0001.RAF",
    returnedToPrimary: true,
    video,
  });
  console.log(
    `${name}: one JPEG timeline primary; both stack members display; details identify JPEG and RAF; H.264 MP4 captured`,
  );
}

try {
  await api(`/admin/users/${state.browser.userId}`, state.adminToken, {
    shouldChangePassword: false,
  });
  await api("/users/me/onboarding", state.pair.token, { isOnboarded: true });
  browser("open", `${baseUrl}/auth/login`);
  browser("wait", "#email");
  browser("fill", "#email", state.browser.email);
  browser("fill", "#password", state.browser.password);
  browser("click", 'button[type="submit"]');
  browser("wait", "--url", "**/photos");
  await demonstrate("desktop", 1440, 1000);
  await demonstrate("mobile-web", 390, 844);
  const imageLabels = JSON.parse(
    await readFile(
      join(process.env.RUNNER_TEMP, "slop-demo-image.json"),
      "utf8",
    ),
  );
  const report = {
    image: process.env.SLOP_IMAGE,
    imageSourceRevision: imageLabels["org.opencontainers.image.revision"],
    workflowRun: process.env.GITHUB_RUN_ID,
    persistentRestart: true,
    testedAt: new Date().toISOString(),
    fixture: {
      source:
        "https://raw.pixls.us/getfile.php/3812/nice/Fujifilm%20-%20X100V%20-%2014bit%2014bit%20compressed%20(3%3A2).RAF",
      sha256:
        "48f2055ab497c687347eee84103d4f48deb016fff711d2810eaf1317e506f621",
      license: "CC0-1.0",
    },
    browserTool: execFileSync("agent-browser", ["--version"], {
      encoding: "utf8",
    }).trim(),
    scope:
      "Real published server image, genuine Fujifilm RAF and embedded JPEG, desktop and responsive mobile web. Native iOS and Android apps are outside this browser demo.",
    checks,
  };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Agent-browser demonstrated JPEG-primary RAW companions against ${process.env.SLOP_IMAGE}. Desktop 1440×1000 and responsive mobile web 390×844 passed. Evidence includes screenshots, sanitized accessibility snapshots, H.264 MP4 videos and report.json. Native mobile apps were not exercised.\n`,
      { flag: "a" },
    );
  }
} catch (error) {
  console.error(error.message);
  try {
    await snapshot("failure");
    await screenshot("failure");
  } catch {}
  process.exitCode = 1;
} finally {
  if (recording) {
    try {
      browser("record", "stop");
    } catch {}
  }
  try {
    browser("close");
  } catch {}
}
