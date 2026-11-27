// What the site's tests use to load the built pages in a real browser (Plan 5, Task 6): a small static server that
// answers the way Cloudflare Pages will (the headers from `_headers`, `/guide/` for the guide, `404.html` with status 404),
// and a minimal client for Edge WebDriver (the W3C protocol over HTTP, no package). It is test equipment: nothing here ships.
//
//   const server = await serve(dir, { headers });       // headers: parseHeaders(text)'s rules; none means none
//   const browser = await openBrowser({ driver });      // driver: the full path to msedgedriver.exe
//   await browser.viewport(1280, 800); await browser.media({ scheme: "dark" }); await browser.goto(server.origin + "/");
//
// The driver is found as the e2e run finds it: the flag, else PETALOCK_EDGEDRIVER, else the runner image's EDGEWEBDRIVER on
// GitHub Actions. Its first three version parts must equal Edge's (Microsoft's rule), which `openBrowser` reads from the
// session it gets.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { basename, extname, isAbsolute, join, normalize, sep } from "node:path";

// ---- _headers ---------------------------------------------------------------------------------------------------

/** The rules of a Cloudflare `_headers` file: `[{ path, headers: [[name, value]] }]`. Anything else in it throws. */
export function parseHeaders(text) {
  const rules = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      rules.push({ path: raw.trim(), headers: [] });
      continue;
    }
    const m = /^\s+([A-Za-z][A-Za-z0-9-]*):\s?(.*\S)\s*$/.exec(raw);
    if (!m || rules.length === 0) throw new Error(`_headers: cannot read the line ${JSON.stringify(raw)}`);
    rules[rules.length - 1].headers.push([m[1], m[2]]);
  }
  return rules;
}

// ---- the server -------------------------------------------------------------------------------------------------

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml" };

/** The file a request path names under `dir`, or null: `/x/` is `/x/index.html`, a path that leaves `dir` is nothing. */
function fileFor(dir, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes("\0") || rel.includes("\\")) return null;
  if (rel.endsWith("/")) rel += "index.html";
  const full = normalize(join(dir, rel));
  if (full !== dir && !full.startsWith(dir + sep)) return null;
  return existsSync(full) && statSync(full).isFile() ? full : null;
}

/**
 * Serves `dir` on a free local port. `headers` are `_headers` rules (only `/*` is understood), sent on every answer. The
 * list `requests` holds every request path the server saw, in order. `close()` stops it.
 */
export async function serve(dir, { headers = [] } = {}) {
  const everything = headers.filter((rule) => rule.path === "/*").flatMap((rule) => rule.headers);
  if (headers.some((rule) => rule.path !== "/*")) throw new Error("serve: only the /* rule is understood");
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://site.invalid");
    requests.push(url.pathname);
    for (const [name, value] of everything) res.setHeader(name, value);
    let file = fileFor(dir, url.pathname);
    let status = 200;
    if (file === null && !url.pathname.endsWith("/") && fileFor(dir, `${url.pathname}/`) !== null) {
      res.statusCode = 301;
      res.setHeader("location", `${url.pathname}/`);
      res.end();
      return;
    }
    if (file === null) {
      file = fileFor(dir, "/404.html");
      status = 404;
    }
    if (file === null) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.statusCode = status;
    res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(readFileSync(file));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    port,
    origin: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

// ---- the driver -------------------------------------------------------------------------------------------------

/** The Edge driver's full path from the flag or the environment, or null when none is given. */
export function findEdgeDriver(env = process.env, flag) {
  const candidate = flag ?? env.PETALOCK_EDGEDRIVER ?? (env.GITHUB_ACTIONS === "true" && env.EDGEWEBDRIVER ? join(env.EDGEWEBDRIVER, "msedgedriver.exe") : undefined);
  if (candidate === undefined || candidate === "") return null;
  if (!isAbsolute(candidate) || basename(candidate).toLowerCase() !== "msedgedriver.exe" || !existsSync(candidate)) {
    throw new Error("the Edge WebDriver must be given as the full path of an existing msedgedriver.exe");
  }
  return candidate;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts the driver and one headless Edge session (scrollbars hidden, so a window width is a layout width). Returns the
 * client; `quit()` ends the session and the driver.
 */
export async function openBrowser({ driver }) {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- the same driver file, one fixed argument
  const versionRun = spawnSync(driver, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  const driverVersion = /(\d+\.\d+\.\d+\.\d+)/.exec(versionRun.status === 0 ? versionRun.stdout : "")?.[1];
  const port = await freePort();
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- the Edge driver the person gave (checked to be a file named msedgedriver.exe), with a fixed argument
  const child = spawn(driver, [`--port=${String(port)}`], { stdio: "ignore", windowsHide: true });
  const base = `http://127.0.0.1:${String(port)}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(`${method} ${path.replace(/\/session\/[0-9a-f]+/, "")}: ${JSON.stringify(json.value).slice(0, 300)}`);
    return json.value;
  };
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
    try {
      ready = (await call("GET", "/status")).ready === true;
    } catch {
      await sleep(250);
    }
  }
  if (!ready) {
    child.kill();
    throw new Error("the Edge WebDriver did not start");
  }
  let sid;
  let version;
  try {
    const session = await call("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "MicrosoftEdge",
          "ms:edgeOptions": { args: ["--headless=new", "--hide-scrollbars", "--disable-gpu", "--no-first-run", "--no-default-browser-check"] },
          "ms:loggingPrefs": { performance: "ALL", browser: "ALL" },
        },
      },
    });
    sid = session.sessionId;
    version = session.capabilities.browserVersion;
  } catch (error) {
    child.kill();
    throw error;
  }
  const first3 = (v) => String(v).split(".").slice(0, 3).join(".");
  if (driverVersion === undefined || first3(driverVersion) !== first3(version)) {
    await call("DELETE", `/session/${sid}`).catch(() => undefined);
    child.kill();
    throw new Error(`the Edge WebDriver (${String(driverVersion)}) and Edge (${String(version)}) do not match in their first three parts`);
  }
  const at = (path) => `/session/${sid}${path}`;
  const cdp = (cmd, params = {}) => call("POST", at("/ms/cdp/execute"), { cmd, params });
  return {
    version,
    async goto(url) {
      await call("POST", at("/url"), { url });
      // fonts and any other late request are part of the load
      await this.runAsync("const done = arguments[arguments.length - 1]; document.fonts.ready.then(() => done(true));");
    },
    async viewport(width, height) {
      await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    },
    /** `scheme` is "light" or "dark"; `forced` turns the Windows contrast themes' media feature on. */
    async media({ scheme = "light", forced = false } = {}) {
      await cdp("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: scheme },
          { name: "forced-colors", value: forced ? "active" : "none" },
        ],
      });
    },
    run: (script, ...args) => call("POST", at("/execute/sync"), { script, args }),
    runAsync: (script, ...args) => call("POST", at("/execute/async"), { script, args }),
    /**
     * The requests the page made since the last call: `[{ url, type }]`, one for every `Network.requestWillBeSent` event in
     * the order they came. A redirect's next hop is its own event under the same request id, so the events are kept, never
     * keyed by id: a hop that leaves the site and returns would otherwise be overwritten by the same-site hop after it.
     */
    async requests() {
      const entries = await call("POST", at("/se/log"), { type: "performance" });
      const requests = [];
      const failed = [];
      for (const entry of entries) {
        const event = JSON.parse(entry.message).message;
        if (event.method === "Network.requestWillBeSent") requests.push({ url: event.params.request.url, type: event.params.type ?? "", redirect: event.params.redirectResponse !== undefined });
        if (event.method === "Network.loadingFailed") failed.push({ requestId: event.params.requestId, error: event.params.errorText, blocked: event.params.blockedReason ?? null });
      }
      return { requests, failed };
    },
    /** The browser's console since the last call, `[{ level, message }]`. */
    async console() {
      const entries = await call("POST", at("/se/log"), { type: "browser" });
      return entries.map((entry) => ({ level: entry.level, message: entry.message }));
    },
    async screenshot() {
      return Buffer.from(await call("GET", at("/screenshot")), "base64");
    },
    async quit() {
      await call("DELETE", `/session/${sid}`).catch(() => undefined);
      child.kill();
    },
  };
}

// ---- axe --------------------------------------------------------------------------------------------------------

/** Where axe-core is (the UI's dev dependency), or null when the UI's packages are not installed. */
export function findAxe(root) {
  const file = join(root, "ui", "node_modules", "axe-core", "axe.min.js");
  return existsSync(file) ? file : null;
}

/**
 * axe-core on the page now loaded, with every rule on (colour contrast included: this is a real browser). Returns
 * `{ violations, incomplete, passes, inapplicable }`: the two first as lists of `{ id, impact, targets }`, the others as counts.
 * "Incomplete" is what axe could not decide (the skipped count the plan asks to record).
 */
export async function runAxe(browser, axeSource) {
  await browser.run(axeSource);
  const result = await browser.runAsync(
    `const done = arguments[arguments.length - 1];
     const slim = (list) => list.map((r) => ({ id: r.id, impact: r.impact, help: r.help, targets: r.nodes.map((n) => n.target.join(" ") + " :: " + (n.failureSummary ?? "").replace(/\\s+/g, " ").slice(0, 200)) }));
     axe.run(document, { resultTypes: ["violations", "incomplete", "passes", "inapplicable"] }).then(
       (r) => done({ violations: slim(r.violations), incomplete: slim(r.incomplete), passes: r.passes.length, inapplicable: r.inapplicable.length }),
       (e) => done({ error: String(e) }));`,
  );
  if (result.error) throw new Error(`axe failed: ${result.error}`);
  return result;
}
