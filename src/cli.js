#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * `serve` is the one an agent runs; everything else is for a human at a
 * terminal. Nothing but MCP frames may reach stdout while serving, so all
 * human-facing output from that path goes to stderr.
 */

import { Command } from "commander";

import { CLIENTS, desktopConfigPath, install, launchSpec } from "./install.js";
import { API_KEY_VAR, CONSOLE_URL, baseUrl } from "./config.js";
import { version } from "./version.js";

const program = new Command();

program
  .name("jev-mcp")
  .description("MCP server exposing TypeSafe's Jev model as a typed-judgment tool")
  .version(version, "-v, --version")
  .showHelpAfterError();

program
  .command("serve", { isDefault: true })
  .description("run the MCP server over stdio (this is what agents invoke)")
  .action(async () => {
    const { serve } = await import("./server.js");
    await serve();
  });

program
  .command("install")
  .description("register this server with Claude Code, Claude Desktop and Codex")
  .option(
    "-c, --client <name>",
    `limit to one client (repeatable): ${CLIENTS.join(", ")}`,
    (value, all) => [...all, value],
    [],
  )
  .option("-n, --dry-run", "print what would be changed, change nothing")
  .action(async (options) => {
    const { results, failures } = await install({
      clients: options.client.length ? options.client : CLIENTS,
      dryRun: Boolean(options.dryRun),
    });

    for (const result of results) {
      const detail = result.reason || result.detail || result.note || "";
      console.log(`${symbolFor(result.status)} ${result.client}${detail ? ` — ${detail}` : ""}`);
    }

    if (failures) {
      console.error(`\n${failures} client(s) failed. Nothing else was changed.`);
      process.exitCode = 1;
      return;
    }
    console.log(options.dryRun ? "\nDry run — no files or configs were touched." : "\nDone.");
  });

program
  .command("doctor")
  .description("check configuration without contacting the API")
  .action(async () => {
    const { command, args } = launchSpec();
    const hasKey = Boolean(process.env[API_KEY_VAR]?.trim());

    console.log(`${symbolFor(hasKey ? "installed" : "failed")} ${API_KEY_VAR} ${hasKey ? "is set" : `is missing — get one at ${CONSOLE_URL}`}`);
    console.log(`  endpoint       ${baseUrl()}`);
    console.log(`  launch command ${[command, ...args].join(" ")}`);
    console.log(`  desktop config ${desktopConfigPath()}`);
    console.log(`  node           ${process.version}`);
    if (!hasKey) process.exitCode = 1;
  });

function symbolFor(status) {
  return { installed: "✓", planned: "·", skipped: "–", failed: "✗" }[status] ?? "·";
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`jev-mcp: ${error?.message ?? error}`);
  process.exit(1);
}
