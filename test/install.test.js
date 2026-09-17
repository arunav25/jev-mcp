import { test } from "node:test";
import assert from "node:assert/strict";

import { desktopConfigPath, install, launchSpec, mergeDesktopConfig } from "../src/install.js";

const entry = { command: "/usr/bin/node", args: ["/opt/jev/src/cli.js", "serve"] };

test("adds the server to an empty config", () => {
  const merged = JSON.parse(mergeDesktopConfig("", entry));
  assert.deepEqual(merged.mcpServers.jev, entry);
});

test("keeps unrelated keys and other servers", () => {
  const existing = JSON.stringify({
    theme: "dark",
    mcpServers: { other: { command: "other-server" } },
  });

  const merged = JSON.parse(mergeDesktopConfig(existing, entry));

  assert.equal(merged.theme, "dark");
  assert.deepEqual(merged.mcpServers.other, { command: "other-server" });
  assert.deepEqual(merged.mcpServers.jev, entry);
});

test("replaces a previous entry of ours", () => {
  const existing = JSON.stringify({ mcpServers: { jev: { command: "stale" } } });
  const merged = JSON.parse(mergeDesktopConfig(existing, entry));
  assert.deepEqual(merged.mcpServers.jev, entry);
});

test("survives a config whose mcpServers is the wrong type", () => {
  const merged = JSON.parse(mergeDesktopConfig(JSON.stringify({ mcpServers: null }), entry));
  assert.deepEqual(merged.mcpServers.jev, entry);
});

test("refuses a config that is not a JSON object", () => {
  assert.throws(() => mergeDesktopConfig("[1,2]", entry), /not a JSON object/);
  assert.throws(() => mergeDesktopConfig("{oops", entry), /JSON/);
});

test("launch spec points at this package's entry point", () => {
  const { command, args } = launchSpec();
  assert.equal(command, process.execPath);
  assert.match(args[0], /src[/\\]cli\.js$/);
  assert.equal(args[1], "serve");
});

test("resolves the desktop config path per platform", () => {
  assert.match(desktopConfigPath("darwin", {}), /Library\/Application Support\/Claude\/claude_desktop_config\.json$/);
  assert.match(desktopConfigPath("win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }), /Claude/);
  assert.match(desktopConfigPath("linux", { XDG_CONFIG_HOME: "/tmp/cfg" }), /^\/tmp\/cfg\/Claude\//);
});

test("install refuses to run without an API key", async () => {
  await assert.rejects(() => install({ env: {} }), /TYPESAFE_API_KEY is not set/);
});

test("install rejects an unknown client name", async () => {
  await assert.rejects(
    () => install({ clients: ["emacs"], env: { TYPESAFE_API_KEY: "k" } }),
    /unknown client/,
  );
});

test("dry run reports a plan and changes nothing", async () => {
  const { results, failures } = await install({
    clients: ["claude-desktop"],
    dryRun: true,
    env: { TYPESAFE_API_KEY: "k" },
  });
  assert.equal(failures, 0);
  assert.ok(["planned", "skipped"].includes(results[0].status));
});
