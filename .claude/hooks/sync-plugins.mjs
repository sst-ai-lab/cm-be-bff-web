// SessionStart hook: adds or refreshes every marketplace in `extraKnownMarketplaces`, then
// installs or updates every plugin enabled in `enabledPlugins` of .claude/settings.json.
// To add a plugin or marketplace, declare it in settings.json; this script needs no changes.
//
// Output contract (SessionStart hook JSON):
//   - nothing changed    -> no output
//   - something changed  -> systemMessage for the user + additionalContext for Claude
//   - operations failed  -> systemMessage listing each failure and the manual command

import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SCOPE = "project";
const COMMAND_TIMEOUT_MS = 120_000;
const SAFE_NAME = /^[\w.@-]+$/;
// Repo slugs, URLs and paths without spaces or shell metacharacters.
const SAFE_SOURCE = /^[\w.@:/\\~#+-]+$/;

const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());

// shell: true lets Windows resolve claude.cmd / claude.exe; every argument is validated
// against SAFE_NAME or SAFE_SOURCE before it reaches the shell.
function runClaude(args) {
  return spawnSync(`claude ${args.join(" ")}`, {
    cwd: projectDir,
    shell: true,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
  });
}

// Claude Code matches a project-scope install by its exact projectPath string, so on Windows
// `d:\repo` (VS Code) and `D:\repo` (terminal) are different projects: a plugin installed from
// one reports "not cached" in the other. Treat spellings that differ only in case as different
// so each launcher gets its own install record.
// realpath still expands Windows 8.3 short names (e.g. HAIBAZ~1) so both spellings compare equal.
function samePath(a, b) {
  const ra = resolve(a);
  const rb = resolve(b);
  if (ra === rb) return true;
  if (ra.toLowerCase() === rb.toLowerCase()) return false;
  const canonical = (p) => {
    try {
      return realpathSync.native(p);
    } catch {
      // Path no longer exists; compare the resolved form.
      return p;
    }
  };
  return canonical(ra) === canonical(rb);
}

function lastLine(text) {
  return (text ?? "").trim().split(/\r?\n/).pop() ?? "";
}

function errorReason(result) {
  if (result.error) return result.error.message;
  const line = lastLine(result.stderr) || lastLine(result.stdout);
  return line.replace(/^✘\s*/, "") || `exit code ${result.status}`;
}

function parseJson(text) {
  try {
    return JSON.parse(lastLine(text));
  } catch {
    return null;
  }
}

function loadSettings() {
  return JSON.parse(readFileSync(join(projectDir, ".claude", "settings.json"), "utf8"));
}

// Map of plugin id -> version installed at project scope for this project
// (`plugin list` also returns plugins installed for other projects).
function installedProjectPlugins() {
  const result = runClaude(["plugin", "list", "--json"]);
  if (result.status !== 0) throw new Error(`cannot list installed plugins: ${errorReason(result)}`);
  const plugins = JSON.parse(result.stdout);
  return new Map(
    plugins
      .filter((p) => p.scope === SCOPE && p.projectPath && samePath(p.projectPath, projectDir))
      .map((p) => [p.id, p.version]),
  );
}

// Names of marketplaces already registered on this machine.
function knownMarketplaces() {
  const result = runClaude(["plugin", "marketplace", "list", "--json"]);
  if (result.status !== 0) throw new Error(`cannot list marketplaces: ${errorReason(result)}`);
  return new Set(JSON.parse(result.stdout).map((m) => m.name));
}

// Translate an `extraKnownMarketplaces` source entry into the `marketplace add <source>` argument.
function marketplaceSource(config) {
  const source = config?.source ?? {};
  switch (source.source) {
    case "github":
      return source.repo;
    case "git":
    case "url":
      return source.url;
    case "directory":
    case "file":
      return source.path;
    default:
      return undefined;
  }
}

function syncMarketplaces(declared) {
  const changed = [];
  const failed = [];
  const known = knownMarketplaces();
  for (const [name, config] of declared) {
    if (known.has(name)) {
      const result = runClaude(["plugin", "marketplace", "update", name]);
      if (result.status !== 0) {
        failed.push({ name, reason: errorReason(result), command: `claude plugin marketplace update ${name}` });
      }
      continue;
    }

    const source = marketplaceSource(config);
    if (!source || !SAFE_SOURCE.test(source)) {
      failed.push({
        name,
        reason: `unsupported marketplace source ${JSON.stringify(config?.source ?? null)}`,
        command: "claude plugin marketplace add <source>",
      });
      continue;
    }
    const result = runClaude(["plugin", "marketplace", "add", source]);
    if (result.status === 0) changed.push(`marketplace ${name}: added`);
    else failed.push({ name, reason: errorReason(result), command: `claude plugin marketplace add ${source}` });
  }
  return { changed, failed };
}

function syncPlugins(ids, installed) {
  const updated = [];
  const newlyInstalled = [];
  const failed = [];
  for (const id of ids) {
    const action = installed.has(id) ? "update" : "install";
    const command = `claude plugin ${action} ${id} --scope ${SCOPE}`;
    const result = runClaude(["plugin", action, id, "--scope", SCOPE, "--json"]);
    const json = parseJson(result.stdout);

    if (json?.outcome !== "ok") {
      failed.push({ name: id, reason: json?.message ?? errorReason(result), command });
    } else if (action === "install") {
      newlyInstalled.push(id);
    } else if (json.oldVersion !== json.newVersion) {
      updated.push(`${id}: ${json.oldVersion} → ${json.newVersion}`);
    }
  }

  // `plugin install --json` does not report a version, so read it back from the installed list.
  const versions = newlyInstalled.length ? installedProjectPlugins() : new Map();
  const changed = [
    ...newlyInstalled.map((id) => `${id}: installed ${versions.get(id) ?? ""}`.trimEnd()),
    ...updated,
  ];
  return { changed, failed };
}

function buildOutput(changed, failed) {
  const lines = [];

  if (changed.length) {
    lines.push("Claude plugins synced:");
    for (const c of changed) lines.push(`  • ${c}`);
    lines.push("Run /reload-plugins to load the changes in this session.");
  }

  if (failed.length) {
    if (lines.length) lines.push("");
    lines.push(`Failed ${failed.length} plugin operation(s):`);
    for (const f of failed) lines.push(`  • ${f.name}: ${f.reason}`, `    Retry manually: ${f.command}`);
  }

  const output = { systemMessage: lines.join("\n") };
  if (changed.length) {
    output.hookSpecificOutput = {
      hookEventName: "SessionStart",
      additionalContext: `Project plugins were synced at session start: ${changed.join("; ")}. Remind the user to run /reload-plugins to load the changes.`,
    };
  }
  return output;
}

function main() {
  const settings = loadSettings();

  const marketplaces = Object.entries(settings.extraKnownMarketplaces ?? {}).filter(([name]) => SAFE_NAME.test(name));
  const plugins = Object.entries(settings.enabledPlugins ?? {})
    .filter(([id, enabled]) => enabled === true && SAFE_NAME.test(id))
    .map(([id]) => id);

  // Marketplaces first: installing a plugin needs its marketplace registered and current.
  const mk = syncMarketplaces(marketplaces);
  const pl = syncPlugins(plugins, installedProjectPlugins());
  const changed = [...mk.changed, ...pl.changed];
  const failed = [...mk.failed, ...pl.failed];

  if (changed.length || failed.length) console.log(JSON.stringify(buildOutput(changed, failed)));
}

// Never block the session: any unexpected error becomes a warning.
try {
  main();
} catch (err) {
  console.log(JSON.stringify({ systemMessage: `Plugin sync skipped: ${err.message}` }));
}
