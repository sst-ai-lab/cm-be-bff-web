// SessionStart hook: adds or refreshes every marketplace in `extraKnownMarketplaces`, then installs or updates
// every plugin enabled in `enabledPlugins` of .claude/settings.json. To add a plugin or marketplace, declare it in
// settings.json; this script needs no changes.
//
// The `claude` CLI is located automatically (PATH, standalone installs, then the binary bundled with the IDE
// extensions). Set CLAUDE_CLI_PATH to override.
//
// Output contract (SessionStart hook JSON):
//   - nothing changed    -> no output
//   - something changed  -> systemMessage for the user + additionalContext for Claude
//   - operations failed  -> systemMessage listing each failure and the manual command

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const SCOPE = "project";
const COMMAND_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 20_000;
// The hook runs under a 300 s timeout (settings.json); stop in time to report what happened instead of being killed.
const SYNC_BUDGET_MS = 270_000;
const MARKETPLACE_WAIT_ATTEMPTS = 10;
const MARKETPLACE_WAIT_INTERVAL_MS = 3_000;

// Marketplace and plugin names.
const SAFE_NAME = /^[\w.@-]+$/;
// Repo slugs, URLs and paths without spaces or shell metacharacters.
const SAFE_SOURCE = /^[\w.@:/\\~#+-]+$/;

const IS_WINDOWS = process.platform === "win32";
const EXE_NAMES = IS_WINDOWS ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
const IDE_DIRS = [".vscode", ".vscode-insiders", ".vscode-server", ".cursor", ".windsurf"];

const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const deadline = Date.now() + SYNC_BUDGET_MS;

// ---------------------------------------------------------------------------------------------------------------
// Locating the claude CLI
// ---------------------------------------------------------------------------------------------------------------

/**
 * Lists the standalone install locations of the CLI, in preference order.
 * @returns {string[]} Candidate executable paths.
 */
function standaloneCandidates() {
    const home = homedir();
    const dirs = [
        join(home, ".local", "bin"),
        ...(IS_WINDOWS
            ? [
                  join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "claude"),
                  join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm"),
              ]
            : ["/usr/local/bin", "/opt/homebrew/bin"]),
    ];
    return dirs.flatMap((dir) => EXE_NAMES.map((exe) => join(dir, exe)));
}

/**
 * Lists the CLIs bundled with the IDE extensions, newest version first. The extensions keep their CLI under a
 * version-stamped directory and never add it to PATH, so the directory name has to be globbed.
 * @returns {string[]} Candidate executable paths.
 */
function extensionCandidates() {
    const found = [];
    for (const ideDir of IDE_DIRS) {
        const root = join(homedir(), ideDir, "extensions");
        let entries;
        try {
            entries = readdirSync(root);
        } catch {
            continue; // Editor not installed, or its extensions directory is unreadable.
        }
        for (const name of entries) {
            const version = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.exec(name);
            if (version) {
                found.push({ rank: version.slice(1).map(Number), dir: join(root, name, "resources", "native-binary") });
            }
        }
    }
    found.sort((a, b) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1] || b.rank[2] - a.rank[2]);
    return found.flatMap(({ dir }) => EXE_NAMES.map((exe) => join(dir, exe)));
}

/**
 * Runs an executable with the given arguments. No shell is involved, except where Windows needs one: a bare
 * `claude`, which may be `claude.cmd` on PATH, and `.cmd`/`.bat` files, which Node refuses to spawn directly.
 * Every argument is checked against SAFE_NAME or SAFE_SOURCE before it gets here.
 * @param {string} executable Bare `claude` or a path to the CLI.
 * @param {string[]} args Command-line arguments.
 * @param {number} timeoutMs Time limit for the command.
 * @returns {import("node:child_process").SpawnSyncReturns<string>} The finished process.
 */
function spawn(executable, args, timeoutMs) {
    const options = { cwd: projectDir, encoding: "utf8", timeout: timeoutMs };
    if (IS_WINDOWS && (executable === "claude" || /\.(cmd|bat)$/i.test(executable))) {
        return spawnSync([quote(executable), ...args].join(" "), { ...options, shell: true });
    }
    return spawnSync(executable, args, options);
}

/**
 * Quotes a path so it survives a shell; a bare `claude` stays unquoted so the shell searches PATH for it.
 * @param {string} executable Bare `claude` or a path to the CLI.
 * @returns {string} The executable as a shell word.
 */
function quote(executable) {
    return executable === "claude" ? executable : `"${executable}"`;
}

let resolvedCli;

/**
 * Finds a working claude CLI, once per run. PATH only has `claude` when the standalone CLI is installed; on a
 * machine with only the IDE extension, a plain `claude ...` call fails with "not recognized as an internal or
 * external command".
 * @returns {string} Bare `claude` or a path to the CLI.
 * @throws {Error} When no candidate runs.
 */
function claudeCli() {
    if (resolvedCli) return resolvedCli;
    const override = process.env.CLAUDE_CLI_PATH;
    const candidates = override
        ? [override]
        : ["claude", ...standaloneCandidates(), ...extensionCandidates()].filter(
              (candidate) => candidate === "claude" || existsSync(candidate),
          );
    resolvedCli = candidates.find((candidate) => spawn(candidate, ["--version"], PROBE_TIMEOUT_MS).status === 0);
    if (!resolvedCli) {
        throw new Error("Claude Code CLI not found. Install it, or point CLAUDE_CLI_PATH at the claude executable.");
    }
    return resolvedCli;
}

// ---------------------------------------------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------------------------------------------

/**
 * Runs `claude <args>`, within what is left of the time budget.
 * @param {string[]} args Command-line arguments.
 * @returns {import("node:child_process").SpawnSyncReturns<string>} The finished process.
 * @throws {Error} When the time budget is spent.
 */
function runClaude(args) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`time budget of ${SYNC_BUDGET_MS / 1000} s spent`);
    return spawn(claudeCli(), args, Math.min(COMMAND_TIMEOUT_MS, remainingMs));
}

/**
 * Spells out a CLI command for the user to run by hand.
 * @param {string[]} args Command-line arguments.
 * @returns {string} The command line.
 */
function formatCommand(args) {
    return [quote(claudeCli()), ...args].join(" ");
}

/**
 * Parses the JSON a `claude ... --json` listing command prints.
 * @param {string[]} args Command-line arguments, `--json` included.
 * @param {string} what What is being listed, for error messages.
 * @returns {*} The parsed output.
 * @throws {Error} When the command fails or prints something else than JSON.
 */
function runClaudeJson(args, what) {
    const result = runClaude(args);
    if (result.status !== 0) throw new Error(`cannot list ${what}: ${errorReason(result)}`);
    try {
        return JSON.parse(result.stdout);
    } catch {
        throw new Error(`cannot read the list of ${what}: \`${formatCommand(args)}\` did not print JSON`);
    }
}

/**
 * @param {string | undefined} text Command output.
 * @returns {string} Its last non-empty line, or "".
 */
function lastLine(text) {
    return (text ?? "").trim().split(/\r?\n/).pop() ?? "";
}

/**
 * Explains why a command failed, from its last line of output.
 * @param {import("node:child_process").SpawnSyncReturns<string>} result The failed process.
 * @returns {string} The reason.
 */
function errorReason(result) {
    if (result.error?.code === "ETIMEDOUT") return "timed out";
    if (result.error) return result.error.message;
    const line = lastLine(result.stderr) || lastLine(result.stdout);
    return line.replace(/^✘\s*/, "") || `exit code ${result.status}`;
}

/**
 * Parses the JSON result `plugin install/update --json` prints on its last line.
 * @param {string | undefined} text Command output.
 * @returns {object | null} The result, or null when there is none.
 */
function parseResultLine(text) {
    try {
        return JSON.parse(lastLine(text));
    } catch {
        return null;
    }
}

/**
 * Blocks for a while; the hook runs synchronously from start to end.
 * @param {number} ms How long to wait.
 */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------------------------------------------
// Settings and what is installed
// ---------------------------------------------------------------------------------------------------------------

/**
 * Tells whether an install recorded for `recorded` belongs to the project at `current`, as Claude Code sees it.
 *
 * Claude Code matches a project-scope install by its exact projectPath string, so on Windows `d:\repo` (VS Code)
 * and `D:\repo` (terminal) are different projects: a plugin installed from one reports "not cached" in the other,
 * and each launcher needs its own install. A path segment that differs only in case therefore means a different
 * project. Other differences, such as a Windows 8.3 short name (HAIBAZ~1) against its long name, are settled by
 * the real path.
 * @param {string} recorded Project path of an install.
 * @param {string} current Project path of this session.
 * @returns {boolean} Whether both name the same project.
 */
function sameProject(recorded, current) {
    const a = resolve(recorded);
    const b = resolve(current);
    if (a === b) return true;
    const segmentsA = a.split(sep);
    const segmentsB = b.split(sep);
    const caseOnly = segmentsA.some(
        (segment, i) => segment !== segmentsB[i] && segment.toLowerCase() === segmentsB[i]?.toLowerCase(),
    );
    return !caseOnly && realPath(a) === realPath(b);
}

/**
 * @param {string} path An absolute path.
 * @returns {string} Its real path, or the path itself when it no longer exists.
 */
function realPath(path) {
    try {
        return realpathSync.native(path);
    } catch {
        return path;
    }
}

/**
 * @returns {object} The project settings, .claude/settings.json.
 */
function loadSettings() {
    return JSON.parse(readFileSync(join(projectDir, ".claude", "settings.json"), "utf8"));
}

/**
 * Reads the plugins installed at project scope for this project; `plugin list` also returns the plugins of other
 * projects.
 * @returns {Map<string, string>} Plugin ID to installed version.
 */
function installedProjectPlugins() {
    const plugins = runClaudeJson(["plugin", "list", "--json"], "installed plugins");
    return new Map(
        plugins
            .filter(
                (plugin) => plugin.scope === SCOPE && plugin.projectPath && sameProject(plugin.projectPath, projectDir),
            )
            .map((plugin) => [plugin.id, plugin.version]),
    );
}

/**
 * @returns {Map<string, object>} The marketplaces registered on this machine, by name.
 */
function knownMarketplaces() {
    const marketplaces = runClaudeJson(["plugin", "marketplace", "list", "--json"], "marketplaces");
    return new Map(marketplaces.map((marketplace) => [marketplace.name, marketplace]));
}

// ---------------------------------------------------------------------------------------------------------------
// Marketplaces
// ---------------------------------------------------------------------------------------------------------------

/**
 * Translates an `extraKnownMarketplaces` entry into the `marketplace add <source>` argument.
 * @param {object} config The entry.
 * @returns {string | undefined} The source, or undefined for an unsupported kind.
 */
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

/**
 * Converts an SSH git URL, `git@host:owner/repo.git` or `ssh://git@host/owner/repo.git`, to its HTTPS equivalent.
 * Some networks block outbound SSH entirely (port 22, and even SSH over 443) while HTTPS still works through a
 * proxy.
 * @param {string} source A marketplace source.
 * @returns {string | undefined} The HTTPS URL, or undefined when the source is not an SSH URL.
 */
function toHttpsUrl(source) {
    const match = /^git@([^:]+):(.+)$/.exec(source) ?? /^ssh:\/\/git@([^/]+)\/(.+)$/.exec(source);
    if (!match) return undefined;
    const [, host, path] = match;
    return `https://${host}/${path}`;
}

/**
 * Tells whether a registered marketplace comes from the declared source. `marketplace update` keeps pulling from
 * the source a marketplace was first added with, so a marketplace of the same name from another repository must
 * be added again. The HTTPS equivalent of a declared SSH source counts as the same repository: once the HTTPS
 * fallback has switched a marketplace over, insisting on the SSH spelling would re-add (and re-clone) it on every
 * session and ask for /reload-plugins each time.
 * @param {object} registered The marketplace as `marketplace list` reports it.
 * @param {object} config Its `extraKnownMarketplaces` entry.
 * @returns {boolean} Whether the sources match.
 */
function sameSource(registered, config) {
    const registeredLocation = (registered.repo ?? registered.url ?? registered.path ?? "").toLowerCase();
    const declared = marketplaceSource(config);
    const accepted = [declared, toHttpsUrl(declared ?? "")].filter(Boolean).map((location) => location.toLowerCase());
    return registered.source === config?.source?.source && accepted.includes(registeredLocation);
}

/**
 * Waits for a marketplace to appear with its declared source. At session start Claude Code itself installs the
 * marketplaces declared in project settings, so the hook's `marketplace add` can race it (e.g. EBUSY on the clone
 * directory); the add counts as done once the marketplace shows up.
 * @param {string} name Marketplace name.
 * @param {object} config Its `extraKnownMarketplaces` entry.
 * @param {number} attempts How many times to look.
 * @returns {boolean} Whether it appeared.
 */
function waitForMarketplace(name, config, attempts = MARKETPLACE_WAIT_ATTEMPTS) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const registered = knownMarketplaces().get(name);
        if (registered && sameSource(registered, config)) return true;
        if (attempt < attempts) sleepSync(MARKETPLACE_WAIT_INTERVAL_MS);
    }
    return false;
}

/**
 * Adds a marketplace, or replaces the source of one with the same name. When the SSH source fails, retries once
 * over HTTPS; a quick look first avoids mistaking a race with Claude Code's own install for an SSH failure.
 * @param {string} name Marketplace name.
 * @param {object} config Its `extraKnownMarketplaces` entry.
 * @param {string} source The declared source.
 * @returns {{result: object, source: string}} The last `marketplace add` run, and the source it used.
 */
function addMarketplace(name, config, source) {
    const result = runClaude(["plugin", "marketplace", "add", source]);
    if (result.status === 0 || waitForMarketplace(name, config, 1)) return { result, source };
    const httpsSource = toHttpsUrl(source);
    if (httpsSource && SAFE_SOURCE.test(httpsSource)) {
        const httpsResult = runClaude(["plugin", "marketplace", "add", httpsSource]);
        if (httpsResult.status === 0) return { result: httpsResult, source: httpsSource };
    }
    return { result, source };
}

/**
 * Brings every declared marketplace up to date: updates the ones registered from their declared source, adds the
 * others.
 * @param {Array<[string, object]>} declared Marketplace names and their `extraKnownMarketplaces` entries.
 * @returns {{changed: string[], failed: object[]}} What changed, and what failed.
 */
function syncMarketplaces(declared) {
    const changed = [];
    const failed = [];
    const known = knownMarketplaces();
    for (const [name, config] of declared) {
        const registered = known.get(name);
        if (registered && sameSource(registered, config)) {
            const args = ["plugin", "marketplace", "update", name];
            const result = runClaude(args);
            if (result.status !== 0) failed.push({ name, reason: errorReason(result), command: formatCommand(args) });
            continue;
        }

        const source = marketplaceSource(config);
        if (!source || !SAFE_SOURCE.test(source)) {
            failed.push({
                name,
                reason: `unsupported marketplace source ${JSON.stringify(config?.source ?? null)}`,
                command: formatCommand(["plugin", "marketplace", "add", "<source>"]),
            });
            continue;
        }

        const added = addMarketplace(name, config, source);
        if (added.result.status === 0 || waitForMarketplace(name, config)) {
            changed.push(`marketplace ${name}: ${registered ? "switched to" : "added"} ${added.source}`);
        } else {
            failed.push({
                name,
                reason: errorReason(added.result),
                command: formatCommand(["plugin", "marketplace", "add", source]),
            });
        }
    }
    return { changed, failed };
}

// ---------------------------------------------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------------------------------------------

/**
 * Installs or updates a plugin. Older Claude Code releases have no `--json` on `plugin install` / `plugin update`;
 * then the command runs again without it, success comes from the exit code, and versions from `plugin list`.
 * @param {"install" | "update"} action What to do.
 * @param {string} id Plugin ID.
 * @returns {{ok: boolean, reason: string, json: object | null}} The outcome, and the JSON result when there is one.
 */
function runPluginCommand(action, id) {
    const args = ["plugin", action, id, "--scope", SCOPE];
    const result = runClaude([...args, "--json"]);
    if (/unknown option\W+--json/.test(`${result.stderr ?? ""}${result.stdout ?? ""}`)) {
        const plain = runClaude(args);
        return { ok: plain.status === 0, reason: errorReason(plain), json: null };
    }
    const json = parseResultLine(result.stdout);
    return { ok: json?.outcome === "ok", reason: json?.message ?? errorReason(result), json };
}

/**
 * Installs the enabled plugins missing from this project and updates the others.
 * @param {string[]} ids Enabled plugin IDs.
 * @param {Map<string, string>} installed Plugin ID to installed version, before the sync.
 * @returns {{changed: string[], failed: object[]}} What changed, and what failed.
 */
function syncPlugins(ids, installed) {
    const updated = [];
    const newlyInstalled = [];
    const updatedWithoutJson = [];
    const failed = [];
    for (const id of ids) {
        const action = installed.has(id) ? "update" : "install";
        const { ok, reason, json } = runPluginCommand(action, id);
        if (!ok) {
            failed.push({ name: id, reason, command: formatCommand(["plugin", action, id, "--scope", SCOPE]) });
        } else if (action === "install") {
            newlyInstalled.push(id);
        } else if (!json) {
            updatedWithoutJson.push(id);
        } else if (json.oldVersion !== json.newVersion) {
            updated.push(`${id}: ${json.oldVersion} → ${json.newVersion}`);
        }
    }

    // `plugin install --json` reports no version (and older releases report nothing): read them back.
    const versions = newlyInstalled.length || updatedWithoutJson.length ? installedProjectPlugins() : new Map();
    for (const id of updatedWithoutJson) {
        if (installed.get(id) !== versions.get(id)) {
            updated.push(`${id}: ${installed.get(id)} → ${versions.get(id)}`);
        }
    }
    const changed = [...newlyInstalled.map((id) => `${id}: installed ${versions.get(id) ?? ""}`.trimEnd()), ...updated];
    return { changed, failed };
}

// ---------------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------------

/**
 * Builds the hook output: a message for the user, and context for Claude when something changed.
 * @param {string[]} changed What changed.
 * @param {Array<{name: string, reason: string, command: string}>} failed What failed.
 * @returns {object} The SessionStart hook JSON.
 */
function buildOutput(changed, failed) {
    const lines = [];
    if (changed.length) {
        lines.push("Claude plugins synced:", ...changed.map((change) => `  • ${change}`));
        lines.push("Run /reload-plugins to load the changes in this session.");
    }
    if (failed.length) {
        if (lines.length) lines.push("");
        lines.push(`Failed ${failed.length} plugin operation(s):`);
        for (const failure of failed) {
            lines.push(`  • ${failure.name}: ${failure.reason}`, `    Retry manually: ${failure.command}`);
        }
    }

    const output = { systemMessage: lines.join("\n") };
    if (changed.length) {
        output.hookSpecificOutput = {
            hookEventName: "SessionStart",
            additionalContext:
                `Project plugins were synced at session start: ${changed.join("; ")}. ` +
                "Remind the user to run /reload-plugins to load the changes.",
        };
    }
    return output;
}

/**
 * Syncs the declared marketplaces, then the enabled plugins, and prints the hook output.
 */
function main() {
    const settings = loadSettings();
    const marketplaces = Object.entries(settings.extraKnownMarketplaces ?? {}).filter(([name]) => SAFE_NAME.test(name));
    const plugins = Object.entries(settings.enabledPlugins ?? {})
        .filter(([id, enabled]) => enabled === true && SAFE_NAME.test(id))
        .map(([id]) => id);

    // Marketplaces first: installing a plugin needs its marketplace registered and current.
    const marketplaceSync = syncMarketplaces(marketplaces);
    const pluginSync = syncPlugins(plugins, installedProjectPlugins());
    const changed = [...marketplaceSync.changed, ...pluginSync.changed];
    const failed = [...marketplaceSync.failed, ...pluginSync.failed];
    if (changed.length || failed.length) console.log(JSON.stringify(buildOutput(changed, failed)));
}

// Never block the session: any unexpected error becomes a warning.
try {
    main();
} catch (error) {
    console.log(JSON.stringify({ systemMessage: `Plugin sync skipped: ${error.message}` }));
}
