#!/usr/bin/env node
/**
 * Startup smoke check for the API server.
 *
 * Builds the server bundle, boots it on an ephemeral port, and verifies:
 *   1. GET  /api/healthz responds 200 with { status: "ok" }
 *   2. POST /api/v1/public/uploads/request-url (a public website endpoint)
 *      responds with a non-5xx status for an invalid body (400 expected),
 *      proving the public router is mounted and zod validation works.
 *
 * Fails loudly (non-zero exit) if the build fails, the process crashes at
 * startup (e.g. the zod bundling regression), or either endpoint misbehaves.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Build into an isolated dir (NOT dist/): the dev workflow builds/serves the
// real dist/, and a concurrent smoke build into the same folder can boot a
// half-written bundle (observed as a SyntaxError mid-file at startup). It
// must stay inside the artifact so external packages (zod, sharp, @resvg/*)
// still resolve via node_modules; .smoke-dist is gitignored.
const smokeDist = path.join(artifactDir, ".smoke-dist");
const BOOT_TIMEOUT_MS = 30_000;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: artifactDir, ...opts });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`)),
    );
    child.on("error", reject);
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function main() {
  console.log("[smoke] building api-server bundle...");
  await run("node", ["./build.mjs"], {
    env: { ...process.env, API_SERVER_OUT_DIR: smokeDist },
  });

  const port = await getFreePort();
  console.log(`[smoke] starting server on port ${port}...`);

  const server = spawn("node", ["--enable-source-maps", path.join(smokeDist, "index.mjs")], {
    cwd: artifactDir,
    env: { ...process.env, PORT: String(port), NODE_ENV: "test" },
    stdio: ["ignore", "inherit", "inherit"],
  });

  let exited = false;
  let exitInfo = null;
  server.on("exit", (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });

  const kill = () => {
    if (!exited) server.kill("SIGTERM");
  };

  try {
    // Poll /api/healthz until it responds or the process dies / timeout hits.
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let health = null;
    for (;;) {
      if (exited) {
        throw new Error(
          `Server process crashed at startup (exit code ${exitInfo?.code}, signal ${exitInfo?.signal}) before /api/healthz responded.`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(`Server did not respond on /api/healthz within ${BOOT_TIMEOUT_MS}ms.`);
      }
      try {
        health = await fetch(`${base}/api/healthz`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    if (health.status !== 200) {
      throw new Error(`/api/healthz returned status ${health.status}, expected 200.`);
    }
    const body = await health.json();
    if (body?.status !== "ok") {
      throw new Error(`/api/healthz returned unexpected body: ${JSON.stringify(body)}`);
    }
    console.log("[smoke] /api/healthz OK");

    // Public endpoint: invalid body must be rejected with a 400 by zod
    // validation — any 5xx or connection failure means the route is broken.
    const pub = await fetch(`${base}/api/v1/public/uploads/request-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (pub.status !== 400) {
      throw new Error(
        `/api/v1/public/uploads/request-url returned status ${pub.status} for invalid body, expected 400.`,
      );
    }
    console.log("[smoke] public endpoint OK (400 for invalid body)");

    if (exited) {
      throw new Error(`Server process exited unexpectedly during checks (code ${exitInfo?.code}).`);
    }

    console.log("[smoke] PASSED: server builds, boots, and serves requests.");
  } finally {
    kill();
  }
}

main().catch((err) => {
  console.error(`[smoke] FAILED: ${err.message}`);
  process.exit(1);
});
