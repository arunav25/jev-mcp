/**
 * Registers this server with the agents that can use it.
 *
 * Claude Code and Codex own their own config, so we go through their CLIs
 * rather than editing files behind their back. Claude Desktop has no CLI, so
 * its JSON is edited directly — atomically, because that file also holds the
 * user's own preferences.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { API_KEY_VAR, CONSOLE_URL, SERVER_NAME, typesafeEnv } from "./config.js";

const run = promisify(execFile);

export const CLIENTS = ["claude-code", "claude-desktop", "codex"];

/**
 * How a client should start this server: the current Node binary plus an
 * absolute path to the entry point. Independent of PATH and of how the
 * package was installed.
 */
export function launchSpec() {
  const entry = fileURLToPath(new URL("./cli.js", import.meta.url));
  return { command: process.execPath, args: [entry, "serve"] };
}

/**
 * Whether a registered entry was created by this package.
 *
 * Setup used to delete any entry under our name before re-adding, on the
 * assumption that it was a previous install of ours. Nothing checked, so a
 * user with their own MCP server called `jev` lost it silently. There is no
 * marker in an MCP config saying who wrote an entry, but the launch path is a
 * good enough signal: our entry runs this package's `src/cli.js`.
 */
export function isOurs(entry, spec) {
  const args = Array.isArray(entry?.args) ? entry.args : [];
  if (spec?.args?.[0] && args.includes(spec.args[0])) return true;
  // A previous install of this package from a different location still counts.
  return args.some((arg) => typeof arg === "string" && /(^|[/\\])jev-mcp[/\\]src[/\\]cli\.js$/.test(arg));
}

/** Claude Desktop's config file for the current platform. */
export function desktopConfigPath(platform = process.platform, env = process.env) {
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    const appData = env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Claude", "claude_desktop_config.json");
}

/**
 * Merges our entry into a Claude Desktop config, preserving every other key.
 * Exported separately so it can be tested without touching a real config.
 * @param {string} existing Current file contents, or "" when absent.
 */
export function mergeDesktopConfig(existing, entry, name = SERVER_NAME, spec = null) {
  let config = {};
  if (existing.trim()) {
    config = JSON.parse(existing);
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("config root is not a JSON object");
    }
  }
  const servers =
    config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : {};

  const existingEntry = servers[name];
  if (existingEntry && spec && !isOurs(existingEntry, spec)) {
    const error = new Error(
      `an MCP server named "${name}" is already configured here and was not created by this package`,
    );
    error.foreign = true;
    throw error;
  }

  return JSON.stringify({ ...config, mcpServers: { ...servers, [name]: entry } }, null, 2) + "\n";
}

/** Replaces a file's contents without ever leaving it half-written. */
async function writeAtomic(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, contents, { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function onPath(binary) {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    await run(probe, [binary]);
    return true;
  } catch {
    return false;
  }
}

/** Reads Claude Code's current entry, for the ownership check and for rollback. */
async function claudeCodeEntry(env, name) {
  const dir = env.CLAUDE_CONFIG_DIR || homedir();
  try {
    const parsed = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8"));
    const entry = parsed?.mcpServers?.[name];
    return entry ? { entry, serialized: JSON.stringify(entry) } : null;
  } catch {
    return null;
  }
}

async function installClaudeCode(spec, envPairs, env, dryRun, name) {
  if (!(await onPath("claude"))) return skipped("Claude Code", "the `claude` CLI is not on PATH");

  const flags = envPairs.flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const addArgs = ["mcp", "add", name, "-s", "user", ...flags, "--", spec.command, ...spec.args];
  if (dryRun) return planned("Claude Code", ["claude", ...addArgs]);

  const previous = await claudeCodeEntry(env, name);
  if (previous && !isOurs(previous.entry, spec)) return foreign("Claude Code", name);

  // `claude mcp add` refuses a name that already exists, so clear ours first
  // and put it back if the add then fails. Only ever our own entry.
  if (previous) await run("claude", ["mcp", "remove", name, "-s", "user"]).catch(() => {});

  try {
    await run("claude", addArgs);
    return ok("Claude Code");
  } catch (error) {
    if (previous) {
      await run("claude", ["mcp", "add-json", name, previous.serialized, "-s", "user"]).catch(() => {});
    }
    return failed("Claude Code", error);
  }
}

async function installCodex(spec, envPairs, _env, dryRun, name) {
  if (!(await onPath("codex"))) return skipped("Codex", "the `codex` CLI is not on PATH");

  const flags = envPairs.flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  const addArgs = ["mcp", "add", name, ...flags, "--", spec.command, ...spec.args];
  if (dryRun) return planned("Codex", ["codex", ...addArgs]);

  try {
    // Codex overwrites an existing entry and exposes no config read path, so
    // ownership cannot be checked here the way it can for the other two.
    await run("codex", addArgs);
    return { ...ok("Codex"), note: `any existing "${name}" entry was replaced` };
  } catch (error) {
    return failed("Codex", error);
  }
}

async function installClaudeDesktop(spec, envPairs, _env, dryRun, name) {
  const path = desktopConfigPath();
  if (!existsSync(dirname(path))) {
    return skipped("Claude Desktop", "the app does not appear to be installed");
  }
  if (dryRun) return planned("Claude Desktop", [`edit ${path}`]);

  const entry = {
    command: spec.command,
    args: spec.args,
    ...(envPairs.length ? { env: Object.fromEntries(envPairs) } : {}),
  };
  try {
    const existing = await readFile(path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    await writeAtomic(path, mergeDesktopConfig(existing, entry, name, spec));
    return { ...ok("Claude Desktop"), note: "restart the app to pick up the server" };
  } catch (error) {
    if (error.foreign) return foreign("Claude Desktop", name);
    return failed("Claude Desktop", error);
  }
}

const INSTALLERS = {
  "claude-code": installClaudeCode,
  "claude-desktop": installClaudeDesktop,
  codex: installCodex,
};

/**
 * @param {object} [options]
 * @param {string[]} [options.clients] Subset of CLIENTS; defaults to all.
 * @param {boolean} [options.dryRun] Report what would happen, change nothing.
 * @param {string} [options.name] Register under this server name instead of the default.
 * @returns {Promise<{results: object[], failures: number}>}
 */
export async function install({ clients = CLIENTS, dryRun = false, env = process.env, name = SERVER_NAME } = {}) {
  if (!env[API_KEY_VAR]?.trim()) {
    throw new Error(
      `${API_KEY_VAR} is not set. Get a key from ${CONSOLE_URL} and set it before installing — ` +
        "its value is written into each client's launch environment, because clients start the " +
        "server without your shell.",
    );
  }

  const unknown = clients.filter((name) => !INSTALLERS[name]);
  if (unknown.length) {
    throw new Error(`unknown client(s): ${unknown.join(", ")}. Choose from ${CLIENTS.join(", ")}.`);
  }

  const spec = launchSpec();
  const envPairs = Object.entries(typesafeEnv(env));
  const results = [];
  for (const client of clients) {
    results.push(await INSTALLERS[client](spec, envPairs, env, dryRun, name));
  }
  return {
    results,
    failures: results.filter((r) => r.status === "failed").length,
    conflicts: results.filter((r) => r.status === "conflict").length,
  };
}

const ok = (client) => ({ client, status: "installed" });
const foreign = (client, name) => ({
  client,
  status: "conflict",
  reason:
    `an MCP server named "${name}" is already registered and was not created by this package — ` +
    `left untouched. Re-run with --name to register under a different name.`,
});
const skipped = (client, reason) => ({ client, status: "skipped", reason });
const planned = (client, argv) => ({ client, status: "planned", detail: argv.join(" ") });
const failed = (client, error) => ({
  client,
  status: "failed",
  reason: (error.stderr || error.message || String(error)).trim(),
});
