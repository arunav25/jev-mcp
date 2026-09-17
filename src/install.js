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
export function mergeDesktopConfig(existing, entry) {
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
  return JSON.stringify({ ...config, mcpServers: { ...servers, [SERVER_NAME]: entry } }, null, 2) + "\n";
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

/** Reads Claude Code's current entry, so a failed add can be rolled back. */
async function claudeCodeEntry(env) {
  const dir = env.CLAUDE_CONFIG_DIR || homedir();
  try {
    const parsed = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8"));
    const entry = parsed?.mcpServers?.[SERVER_NAME];
    return entry ? JSON.stringify(entry) : null;
  } catch {
    return null;
  }
}

async function installClaudeCode({ command, args }, envPairs, env, dryRun) {
  if (!(await onPath("claude"))) return skipped("Claude Code", "the `claude` CLI is not on PATH");

  const flags = envPairs.flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  const addArgs = ["mcp", "add", SERVER_NAME, "-s", "user", ...flags, "--", command, ...args];
  if (dryRun) return planned("Claude Code", ["claude", ...addArgs]);

  // `claude mcp add` refuses a name that already exists, so clear it first and
  // put the old entry back if the add then fails.
  const previous = await claudeCodeEntry(env);
  await run("claude", ["mcp", "remove", SERVER_NAME, "-s", "user"]).catch(() => {});

  try {
    await run("claude", addArgs);
    return ok("Claude Code");
  } catch (error) {
    if (previous) {
      await run("claude", ["mcp", "add-json", SERVER_NAME, previous, "-s", "user"]).catch(() => {});
    }
    return failed("Claude Code", error);
  }
}

async function installCodex({ command, args }, envPairs, _env, dryRun) {
  if (!(await onPath("codex"))) return skipped("Codex", "the `codex` CLI is not on PATH");

  const flags = envPairs.flatMap(([name, value]) => ["--env", `${name}=${value}`]);
  const addArgs = ["mcp", "add", SERVER_NAME, ...flags, "--", command, ...args];
  if (dryRun) return planned("Codex", ["codex", ...addArgs]);

  try {
    // Codex overwrites an existing entry, so no cleanup dance is needed.
    await run("codex", addArgs);
    return ok("Codex");
  } catch (error) {
    return failed("Codex", error);
  }
}

async function installClaudeDesktop({ command, args }, envPairs, _env, dryRun) {
  const path = desktopConfigPath();
  if (!existsSync(dirname(path))) {
    return skipped("Claude Desktop", "the app does not appear to be installed");
  }
  if (dryRun) return planned("Claude Desktop", [`edit ${path}`]);

  const entry = { command, args, ...(envPairs.length ? { env: Object.fromEntries(envPairs) } : {}) };
  try {
    const existing = await readFile(path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    await writeAtomic(path, mergeDesktopConfig(existing, entry));
    return { ...ok("Claude Desktop"), note: "restart the app to pick up the server" };
  } catch (error) {
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
 * @returns {Promise<{results: object[], failures: number}>}
 */
export async function install({ clients = CLIENTS, dryRun = false, env = process.env } = {}) {
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
  for (const name of clients) {
    results.push(await INSTALLERS[name](spec, envPairs, env, dryRun));
  }
  return { results, failures: results.filter((r) => r.status === "failed").length };
}

const ok = (client) => ({ client, status: "installed" });
const skipped = (client, reason) => ({ client, status: "skipped", reason });
const planned = (client, argv) => ({ client, status: "planned", detail: argv.join(" ") });
const failed = (client, error) => ({
  client,
  status: "failed",
  reason: (error.stderr || error.message || String(error)).trim(),
});
