import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { parseEnv } from "node:util";
import { resolve } from "node:path";

const action = process.argv[2];
const binary = resolve(".local/bin/celld");

const storage = [
  "--bucket",
  "s3://companion",
  "--endpoint",
  "http://127.0.0.1:8333",
  "--region",
  "us-east-1",
];

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", ...options });

const compose = (...args) =>
  run("docker", ["compose", "-f", "compose.local.yaml", "--profile", "test", ...args]);

const prepare = (test) =>
  run(process.execPath, ["scripts/local-prepare.mjs", ...(test ? ["--test"] : [])]);

async function credentials() {
  return {
    ...process.env,
    ...parseEnv(await readFile(".local/config/celld.env", "utf8")),
    CELLD_ESBUILD: resolve("node_modules/esbuild/bin/esbuild"),
  };
}

async function setup() {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw new Error("This local Compose runner currently supports Linux x64/arm64 only");
  await mkdir(".local/bin", { recursive: true });
  await mkdir(".local/config", { recursive: true });
  const target = process.arch === "x64" ? "x86_64" : "aarch64";

  const digest =
    process.arch === "x64"
      ? "ce0ee3552cc8d55dde3998dc3b1b0c8f547bbcb4bc803d2a94842368b047646c"
      : "4eca87c6797590000a344c1b768364e9696e8817f5fbc16193f459d2edac7cd0";

  const archive = resolve(".local/bin/celld.gz");
  let compressed;

  try {
    compressed = await readFile(archive);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (!compressed || createHash("sha256").update(compressed).digest("hex") !== digest) {
    const response = await fetch(
      "https://github.com/denoland/celld/releases/download/v0.6.2/celld-" +
        target +
        "-unknown-linux-gnu.gz",
      { signal: AbortSignal.timeout(120000) },
    );

    if (!response.ok) throw new Error("celld download failed: " + response.status);
    compressed = Buffer.from(await response.arrayBuffer());

    if (createHash("sha256").update(compressed).digest("hex") !== digest)
      throw new Error("celld release checksum mismatch");
    await writeFile(archive, compressed);
  }

  // Avoid overwriting an executable that is already mounted/running inside Docker.
  const executable = gunzipSync(compressed);
  let installed;

  try {
    installed = await readFile(binary);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (!installed?.equals(executable)) await writeFile(binary, executable, { mode: 0o755 });
  await chmod(binary, 0o755);
  run(binary, ["--version"]);

  let env;

  try {
    env = parseEnv(await readFile(".local/config/celld.env", "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    env = {
      AWS_ACCESS_KEY_ID: "companion-local",
      AWS_SECRET_ACCESS_KEY: randomBytes(32).toString("hex"),
      AWS_REGION: "us-east-1",
    };
    await writeFile(
      ".local/config/celld.env",
      Object.entries(env)
        .map(([key, value]) => key + "=" + value)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
  }

  await writeFile(
    ".local/config/s3.json",
    JSON.stringify(
      {
        identities: [
          {
            name: "companion-local",
            credentials: [
              { accessKey: env.AWS_ACCESS_KEY_ID, secretKey: env.AWS_SECRET_ACCESS_KEY },
            ],
            actions: ["Admin", "Read", "Write", "List", "Tagging"],
          },
        ],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  prepare(false);
}

async function deploy(test = false) {
  prepare(test);
  run(binary, ["deploy", "wrangler.celld.local.json", ...storage], { env: await credentials() });
}

function ensureBucket() {
  const args = [
    "compose",
    "-f",
    "compose.local.yaml",
    "exec",
    "-T",
    "seaweedfs",
    "weed",
    "shell",
    "-master=seaweedfs:9333",
    "-filer=seaweedfs:8888",
  ];

  const listing = execFileSync("docker", args, {
    input: "s3.bucket.list\n",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });

  const exists = listing.split("\n").some((line) => line.trim().split(/\s+/, 1)[0] === "companion");

  if (!exists)
    run("docker", args, {
      input: "s3.bucket.create -name companion\n",
      stdio: ["pipe", "inherit", "inherit"],
    });
}

switch (action) {
  case "up":
    await setup();
    compose("up", "-d", "--wait", "seaweedfs");
    ensureBucket();
    // Fleet advertisements use Docker DNS; diagnose from that network, not the host.
    compose("run", "--rm", "--no-deps", "celld", "diagnose");
    await deploy();
    compose("up", "-d", "celld");
    console.log(
      "Companion: http://localhost:9876. Configure .local/config/worker-vars.json, then pnpm local:deploy.",
    );
    break;
  case "deploy":
    await deploy();
    break;
  case "diagnose":
    compose("run", "--rm", "--no-deps", "celld", "diagnose");
    break;
  case "down":
    compose("down"); // Named volumes are retained; no automatic data deletion.
    break;
  case "test":
    console.log(
      "Temporarily replaces this local listener's deployment and restarts celld; do not run against an active personal conversation.",
    );

    try {
      await deploy(true);
      compose("up", "-d", "fixtures");
      compose("restart", "celld");
      run(process.execPath, ["scripts/local-smoke.mjs"]);
    } finally {
      await deploy();
      compose("stop", "fixtures");
      compose("restart", "celld");
    }

    break;
  default:
    throw new Error("Usage: node scripts/local.mjs up|deploy|diagnose|down|test");
}
