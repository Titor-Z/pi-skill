/**
 * @foolsecret/pi-skill — skill manager for pi
 *
 * Commands:
 *   /skill                Interactive panel: toggle skills on/off (saved instantly)
 *   /skill create [name]  Scaffold a new skill (interactive wizard without a name)
 *   /skill lint [name]    Report Agent Skills spec errors (all skills, or one)
 *   /skill help           Show the subcommand help
 *
 * Enable/disable is stored in ~/.pi/agent/settings.json as `!pattern` override
 * entries in the `skills` array — pi's native resource enable/disable mechanism
 * (same one `pi config` uses). Takes effect after restart or /reload.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, getKeybindings, Key, matchesKey } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";


const MAX_NAME = 64;
const MAX_DESC = 1024;
const PANEL_MAX_VISIBLE = 8;

// ---------------------------------------------------------------- discovery

interface SkillEntry {
  name: string;
  description: string;
  filePath: string; // SKILL.md path (or the loose .md file)
  scope: "global" | "project";
  errors: string[]; // spec validation errors, empty if valid
}

function parseFrontmatter(text: string): Record<string, string> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function validateName(name: string): string[] {
  const errors: string[] = [];
  if (name.length > MAX_NAME) errors.push(`name exceeds ${MAX_NAME} characters (${name.length})`);
  if (!/^[a-z0-9-]+$/.test(name)) errors.push("name must be lowercase a-z, 0-9, hyphens only");
  if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
  if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
  return errors;
}

function skillFromMd(filePath: string, scope: SkillEntry["scope"]): SkillEntry | null {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(text);
  const name = fm?.name ?? "";
  const description = fm?.description ?? "";
  const errors: string[] = [];
  if (!fm) errors.push("missing frontmatter");
  errors.push(...validateName(name).map((e) => `name: ${e}`));
  if (!description.trim()) errors.push("description is required");
  else if (description.length > MAX_DESC) errors.push(`description exceeds ${MAX_DESC} chars`);
  return { name, description, filePath, scope, errors };
}

function scanSkillDir(dir: string, scope: SkillEntry["scope"], includeLooseMd: boolean): SkillEntry[] {
  const found: SkillEntry[] = [];
  const walk = (current: string, isRoot: boolean): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    // skill root: SKILL.md wins, stop descending
    const skillMd = entries.find((e) => e.isFile() && e.name === "SKILL.md");
    if (skillMd) {
      const s = skillFromMd(join(current, "SKILL.md"), scope);
      if (s) found.push(s);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, false);
      } else if (isRoot && includeLooseMd && entry.isFile() && entry.name.endsWith(".md")) {
        const s = skillFromMd(full, scope);
        if (s) found.push(s);
      }
    }
  };
  if (!existsSync(dir)) return found;
  walk(dir, true);
  return found;
}

/** Discover skills across pi's standard locations, deduped by name (first wins). */
function discoverSkills(cwd: string): SkillEntry[] {
  const agentDir = join(homedir(), ".pi", "agent");
  const all = [
    ...scanSkillDir(join(agentDir, "skills"), "global", true),
    ...scanSkillDir(join(homedir(), ".agents", "skills"), "global", false),
    ...scanSkillDir(join(cwd, ".pi", "skills"), "project", true),
    ...scanSkillDir(join(cwd, ".agents", "skills"), "project", false),
  ];
  const seen = new Set<string>();
  return all.filter((s) => {
    if (!s.name || seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
}

// ---------------------------------------------------------------- lint

/**
 * Scan all standard skill locations without dedupe or name filtering, so that
 * broken skills (missing/invalid name) are still linted instead of dropped.
 */
function scanAllForLint(cwd: string): SkillEntry[] {
  return [
    ...scanSkillDir(join(homedir(), ".pi", "agent", "skills"), "global", true),
    ...scanSkillDir(join(homedir(), ".agents", "skills"), "global", false),
    ...scanSkillDir(join(cwd, ".pi", "skills"), "project", true),
    ...scanSkillDir(join(cwd, ".agents", "skills"), "project", false),
  ];
}

/** Deterministic, error-level-only spec check for one discovered entry. */
function lintSkillEntry(entry: SkillEntry): string[] {
  const errors = [...entry.errors];
  const base = basename(entry.filePath);
  if (entry.name) {
    if (base === "SKILL.md") {
      const dirName = basename(dirname(entry.filePath));
      if (entry.name !== dirName) errors.push(`name "${entry.name}" does not match directory "${dirName}"`);
    } else if (entry.name !== base.replace(/\.md$/, "")) {
      errors.push(`name "${entry.name}" does not match file "${base}"`);
    }
  }
  // empty body: nothing but whitespace after the frontmatter block
  try {
    const text = readFileSync(entry.filePath, "utf-8");
    const m = /^---\r?\n[\s\S]*?\r?\n---/.exec(text);
    const body = m ? text.slice(m.index + m[0].length) : text;
    if (!body.trim()) errors.push("empty body");
  } catch {
    // unreadable is already reported by the scanner
  }
  return errors;
}

// ------------------------------------------------------- enable/disable list

interface SettingsDoc {
  skills?: string[];
  [key: string]: unknown;
}

function settingsPath(): string {
  return join(homedir(), ".pi", "agent", "settings.json");
}

function readSettings(): SettingsDoc {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf-8")) as SettingsDoc;
  } catch {
    return {};
  }
}

/** Patterns (without the leading "!") that disable resources, from settings.skills. */
function disabledPatterns(settings: SettingsDoc): string[] {
  return (settings.skills ?? []).filter((p) => p.startsWith("!")).map((p) => p.slice(1));
}

/** Mirror pi's matcher closely enough for name-based toggles. */
function patternMatches(pattern: string, skill: SkillEntry): boolean {
  if (pattern === skill.name) return true;
  const rel = relative(join(skill.filePath, "..", ".."), skill.filePath);
  if (pattern === rel || pattern === skill.filePath) return true;
  if (pattern.includes("*")) {
    // minimal glob: * matches any run of non-slash chars
    const rx = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    if (rx.test(skill.name) || rx.test(rel)) return true;
  }
  return false;
}

function isDisabled(settings: SettingsDoc, skill: SkillEntry): boolean {
  return disabledPatterns(settings).some((p) => patternMatches(p, skill));
}

/**
 * Toggle one or more skills in settings.skills by adding/removing the exact
 * `!name` override entries. All other entries (search paths, unrelated
 * overrides) are preserved untouched. Glob-style stale overrides are left to
 * the panel's clean-stale action.
 */
function setDisabled(skills: SkillEntry | SkillEntry[], disabled: boolean): void {
  const settings = readSettings();
  const list = new Set(settings.skills ?? []);
  for (const skill of Array.isArray(skills) ? skills : [skills]) {
    if (disabled) list.add(`!${skill.name}`);
    else list.delete(`!${skill.name}`);
  }
  settings.skills = [...list];
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + "\n");
}

// ---------------------------------------------------------------- panel UI

/** Stale `!pattern` entries in settings that point at no known skill. */
function stalePatterns(settings: SettingsDoc, skills: SkillEntry[]): string[] {
  return disabledPatterns(settings).filter((p) => !skills.some((s) => patternMatches(p, s)));
}

/** Human-readable label for a keybinding, e.g. "Enter" / "Ctrl+A". */
function keyLabel(binding: Parameters<ReturnType<typeof getKeybindings>["getKeys"]>[0]): string {
  const format = (key: string): string =>
    key
      .split("+")
      .map((part) => {
        const p = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
        return p.charAt(0).toUpperCase() + p.slice(1);
      })
      .join("+");
  return getKeybindings()
    .getKeys(binding)
    .map(format)
    .join("/");
}

// ------------------------------------------------- shared text layout helpers

/** Word-wrap plain text to the given available width. */
function wordWrap(text: string, avail: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= avail) cur += ` ${word}`;
    else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Wrap with a fixed indent on every line, so continuation lines align with the first. */
function wrapDetail(content: string, indent: number, width: number): string[] {
  const pad = " ".repeat(indent);
  return wordWrap(content, Math.max(10, width - indent)).map((l) => pad + l);
}

const LIST_MARKER_RE = /(^|\s)([-•*]|\d{1,2}[.)]|\([a-z0-9]{1,2}\)|[a-z]\))(?=\s)/gi;

/** Split an inline enumeration ("(a) … (b) …", "1. … 2. …", "- … - …") into intro + items; null if not list-like. */
function splitList(description: string): { intro: string; items: string[] } | null {
  const marks: number[] = [];
  for (const m of description.matchAll(LIST_MARKER_RE)) {
    marks.push((m.index ?? 0) + m[1].length);
  }
  if (marks.length < 2) return null;
  const intro = description.slice(0, marks[0]).trim();
  const items = marks.map((start, i) =>
    description.slice(start, i + 1 < marks.length ? marks[i + 1] : description.length).trim(),
  );
  return { intro, items };
}

/**
 * Render a description as wrapped detail lines. Inline enumerations — ordered
 * ("(a) …", "1. …") and unordered ("- …", "• …") — are laid out as list blocks:
 * each item on its own line, continuation lines aligned under the item text.
 */
function renderDescription(description: string, width: number): string[] {
  const list = splitList(description);
  if (!list) return wrapDetail(description, 2, width);
  const out: string[] = [];
  if (list.intro) out.push(...wrapDetail(list.intro, 2, width));
  for (const item of list.items) {
    const m = /^(\S+)\s+(.*)$/s.exec(item);
    const marker = m ? m[1] : item;
    const text = m ? m[2] : "";
    const textIndent = 4 + marker.length + 1;
    const lines = wordWrap(text, Math.max(10, width - textIndent));
    out.push(" ".repeat(4) + marker + (lines[0] ? ` ${lines[0]}` : ""));
    for (const l of lines.slice(1)) out.push(" ".repeat(textIndent) + l);
  }
  return out;
}

function openPanel(pi: ExtensionAPI, ctx: ExtensionCommandContext, skills: SkillEntry[]): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  if (skills.length === 0) {
    ui.notify("No skills found.", "info");
    return Promise.resolve();
  }
  void pi;
  return ui.custom<void>((tui, theme, _kb, done) => {
    const state = skills.map((s) => ({ skill: s, disabled: isDisabled(readSettings(), s) }));
    let cursor = 0;
    let filter = ""; // always focused (single-focus input, like /scoped-models)

    const filtered = (): typeof state => {
      if (!filter) return state;
      return fuzzyFilter(state, filter, (s) => `${s.skill.name} ${s.skill.description}`);
    };

    const component = {
      invalidate(): void {
        tui.requestRender();
      },
      render(width: number): string[] {
        const items = filtered();
        if (cursor > items.length - 1) cursor = Math.max(0, items.length - 1);
        const enabled = state.filter((s) => !s.disabled).length;
        const rows: string[] = [];
        const border = theme.fg("border", "─".repeat(Math.max(1, width)));

        rows.push(border);
        rows.push("");
        rows.push(theme.bold("Skill Configuration"));
        rows.push(theme.fg("dim", "Saved instantly. Takes effect after /reload."));
        rows.push("");
        rows.push(filter ? `> ${filter}█` : theme.fg("dim", "> type to filter"));
        rows.push("");
        if (items.length === 0) {
          rows.push(theme.fg("dim", "  No matching skills"));
        } else {
          // centered scrolling viewport (same as /scoped-models)
          const start = Math.max(0, Math.min(cursor - Math.floor(PANEL_MAX_VISIBLE / 2), items.length - PANEL_MAX_VISIBLE));
          const end = Math.min(start + PANEL_MAX_VISIBLE, items.length);
          for (let i = start; i < end; i++) {
            const { skill, disabled } = items[i];
            const selected = i === cursor;
            const prefix = selected ? theme.fg("accent", "→ ") : "  ";
            const status = disabled ? "  " : theme.fg("success", "✓ ");
            const name = disabled ? theme.fg("dim", skill.name) : selected ? theme.fg("accent", skill.name) : skill.name;
            const scope = theme.fg("dim", skill.scope === "global" ? " [global]" : " [project]");
            const warn = skill.errors.length > 0 ? theme.fg("error", " ⚠") : "";
            rows.push(`${prefix}${status}${name}${scope}${warn}`);
          }
          // position indicator: always visible (like a selection stat, even when nothing scrolls)
          rows.push(theme.fg("dim", `  (${cursor + 1}/${items.length})`));
          rows.push("");
          // detail lines for the selected skill (lists split out, everything word-wrapped with aligned continuations)
          const sel = items[cursor]?.skill;
          if (sel) {
            const detail =
              sel.errors.length > 0
                ? wrapDetail(`⚠ ${sel.name}: ${sel.errors.join("; ")}`, 2, width).map((l) => theme.fg("error", l))
                : renderDescription(sel.description || "(no description)", width).map((l) => theme.fg("dim", l));
            rows.push(...detail);
          }
        }
        rows.push("");
        // footer: keybinding hints + counter (mirrors /scoped-models)
        const stale = stalePatterns(readSettings(), state.map((s) => s.skill));
        const parts = [
          `${keyLabel("tui.select.confirm")} toggle`,
          "ctrl+a all",
          "ctrl+x clear",
        ];
        if (stale.length > 0) parts.push("ctrl+d clean stale");
        parts.push(enabled === state.length ? "all enabled" : `${enabled}/${state.length} enabled`);
        rows.push(theme.fg("dim", parts.join(" · ")));
        rows.push(border);
        return rows;
      },
      handleInput(data: string): void {
        const items = filtered();
        if (cursor > items.length - 1) cursor = Math.max(0, items.length - 1);

        const apply = (targets: SkillEntry[], disabled: boolean): void => {
          setDisabled(targets, disabled);
          for (const entry of state) {
            if (targets.includes(entry.skill)) entry.disabled = disabled;
          }
          tui.requestRender();
        };

        if (matchesKey(data, Key.up)) {
          // wraps at both ends, like /scoped-models
          cursor = items.length === 0 ? 0 : cursor === 0 ? items.length - 1 : cursor - 1;
          tui.requestRender();
        } else if (matchesKey(data, Key.down)) {
          cursor = items.length === 0 ? 0 : cursor === items.length - 1 ? 0 : cursor + 1;
          tui.requestRender();
        } else if (matchesKey(data, Key.enter)) {
          const entry = items[cursor];
          if (entry) apply([entry.skill], !entry.disabled);
        } else if (matchesKey(data, Key.ctrl("a"))) {
          // enable all (filtered set when a filter is active)
          apply(items.map((s) => s.skill), false);
        } else if (matchesKey(data, Key.ctrl("x"))) {
          // disable all (filtered set when a filter is active)
          apply(items.map((s) => s.skill), true);
        } else if (matchesKey(data, Key.ctrl("d"))) {
          const all = state.map((s) => s.skill);
          const stale = stalePatterns(readSettings(), all);
          if (stale.length > 0) {
            const settings = readSettings();
            settings.skills = (settings.skills ?? []).filter((p) => !(p.startsWith("!") && stale.includes(p.slice(1))));
            writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + "\n");
            tui.requestRender();
          }
        } else if (matchesKey(data, Key.escape)) {
          // first escape clears the filter, second closes the panel
          if (filter) {
            filter = "";
            cursor = 0;
            tui.requestRender();
          } else {
            done();
          }
        } else if (matchesKey(data, Key.backspace)) {
          filter = filter.slice(0, -1);
          cursor = 0;
          tui.requestRender();
        } else if (data.length === 1 && data >= " " && data !== "\x7f") {
          filter += data;
          cursor = 0;
          tui.requestRender();
        }
      },
    };
    return component;
  });
}

// ---------------------------------------------------------------- create

const PLACEHOLDER_DESCRIPTION =
  "What this skill does and when to use it. Be specific — the description decides when the agent loads it.";

const CREATE_TEMPLATE = (name: string, description: string) => `---
name: ${name}
description: ${description}
---

# ${name}

## Usage

Describe the workflow here. Reference relative paths from this skill directory, e.g.
[references/guide.md](references/guide.md).
`;

function globalSkillsDir(): string {
  return join(homedir(), ".pi", "agent", "skills");
}

function scaffoldSkill(name: string, description: string): string {
  const dir = join(globalSkillsDir(), name);
  mkdirSync(join(dir, "references"), { recursive: true });
  const skillPath = join(dir, "SKILL.md");
  writeFileSync(skillPath, CREATE_TEMPLATE(name, description));
  return skillPath;
}

/**
 * Interactive two-step create wizard (name → description), styled like the
 * management panel: framed, single-focus input, realtime validation hints.
 * Resolves to the created SKILL.md path, or null when cancelled.
 */
function openCreateWizard(ctx: ExtensionCommandContext): Promise<string | null> {
  const ui: ExtensionUIContext = ctx.ui;
  return ui.custom<string | null>((tui, theme, _kb, done) => {
    let step: "name" | "description" = "name";
    let name = "";
    let input = "";

    const liveErrors = (): string[] => {
      if (step === "name") {
        const errs = validateName(input);
        if (errs.length === 0 && existsSync(join(globalSkillsDir(), input, "SKILL.md"))) {
          errs.push("skill already exists");
        }
        return errs;
      }
      return input.length > MAX_DESC ? [`description exceeds ${MAX_DESC} characters (${input.length})`] : [];
    };

    const component = {
      invalidate(): void {
        tui.requestRender();
      },
      render(width: number): string[] {
        const rows: string[] = [];
        const border = theme.fg("border", "─".repeat(Math.max(1, width)));
        rows.push(border);
        rows.push("");
        rows.push(theme.bold("Create Skill"));
        rows.push("");
        if (step === "name") {
          rows.push(`Name ${theme.fg("dim", "(lowercase a-z, 0-9, hyphens)")}`);
        } else {
          rows.push(`Description ${theme.fg("dim", `(${input.length}/${MAX_DESC})`)}`);
        }
        rows.push(`> ${input}█`);
        const errs = liveErrors();
        if (errs.length > 0) {
          rows.push(...wrapDetail(errs.join("; "), 2, width).map((l) => theme.fg("error", l)));
        } else if (step === "description" && !input.trim()) {
          rows.push(theme.fg("dim", "  description is required"));
        }
        rows.push("");
        rows.push(theme.fg("dim", `${keyLabel("tui.select.confirm")} ${step === "name" ? "next" : "create"} · Esc cancel · ${step === "name" ? 1 : 2}/2`));
        rows.push(border);
        return rows;
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
          done(null);
          return;
        }
        if (matchesKey(data, Key.enter)) {
          const errs = liveErrors();
          if (step === "name") {
            if (errs.length > 0) return; // invalid name: submit blocked, hint already rendered
            name = input;
            step = "description";
            input = "";
            tui.requestRender();
            return;
          }
          if (errs.length > 0 || !input.trim()) return; // over-long or empty description: blocked
          const skillPath = join(globalSkillsDir(), name, "SKILL.md");
          if (existsSync(skillPath)) return; // raced: someone created it meanwhile
          done(scaffoldSkill(name, input.trim()))!;
          return;
        }
        if (matchesKey(data, Key.backspace)) {
          input = input.slice(0, -1);
          tui.requestRender();
          return;
        }
        if (data.length === 1 && data >= " " && data !== "\x7f") {
          input += data;
          tui.requestRender();
        }
      },
    };
    return component;
  });
}

function cmdCreate(rest: string, ctx: ExtensionCommandContext): Promise<void> | void {
  const name = rest.trim();
  if (!name) {
    // no name given: interactive wizard
    return openCreateWizard(ctx).then((path) => {
      if (path) ctx.ui.notify(`Created skill scaffold: ${path}`, "info");
    });
  }
  const single = name.split(/\s+/)[0];
  const errors = validateName(single);
  if (errors.length > 0) {
    ctx.ui.notify(`Invalid skill name: ${errors.join("; ")}`, "error");
    return;
  }
  const skillPath = join(globalSkillsDir(), single, "SKILL.md");
  if (existsSync(skillPath)) {
    ctx.ui.notify(`Skill already exists: ${skillPath}`, "error");
    return;
  }
  ctx.ui.notify(`Created skill scaffold: ${scaffoldSkill(single, PLACEHOLDER_DESCRIPTION)}`, "info");
}

// ---------------------------------------------------------------- lint cmd

function cmdLint(rest: string, ctx: ExtensionCommandContext): void {
  const target = rest.trim();
  const entries = scanAllForLint(ctx.cwd ?? process.cwd());
  if (entries.length === 0) {
    ctx.ui.notify("No skills found.", "info");
    return;
  }
  const picked = target
    ? entries.filter((e) => {
        if (e.name === target) return true;
        const base = basename(e.filePath);
        return base === "SKILL.md" ? basename(dirname(e.filePath)) === target : base.replace(/\.md$/, "") === target;
      })
    : entries;
  if (picked.length === 0) {
    ctx.ui.notify(`No skill found: ${target}`, "warning");
    return;
  }
  const results = picked.map((e) => ({ entry: e, errors: lintSkillEntry(e) }));
  const bad = results.filter((r) => r.errors.length > 0);
  if (bad.length === 0) {
    ctx.ui.notify(`${results.length} skill${results.length === 1 ? "" : "s"} OK`, "info");
    return;
  }
  const report = bad.map((r) => `${r.entry.filePath}\n  ${r.errors.join("\n  ")}`).join("\n");
  ctx.ui.notify(`${bad.length}/${results.length} skills failed lint:\n${report}`, "error");
}

// ---------------------------------------------------------------- dispatcher

interface SubCommand {
  name: string;
  args: string;
  description: string;
  handler: (rest: string, ctx: ExtensionCommandContext) => void | Promise<void>;
}

const SUBCOMMANDS: SubCommand[] = [
  { name: "create", args: "[name]", description: "scaffold a new skill (interactive without a name)", handler: cmdCreate },
  { name: "lint", args: "[name]", description: "report Agent Skills spec errors (all skills, or one)", handler: cmdLint },
];

function helpBody(): string {
  const lefts = ["/skill", ...SUBCOMMANDS.map((c) => `/skill ${c.name} ${c.args}`.trimEnd()), "/skill help"];
  const descs = [
    "open the skill management panel",
    ...SUBCOMMANDS.map((c) => c.description),
    "show this help",
  ];
  const width = Math.max(...lefts.map((s) => s.length)) + 2;
  return lefts.map((l, i) => `${l.padEnd(width)}${descs[i]}`).join("\n");
}

function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

export default function skillManager(pi: ExtensionAPI) {
  pi.registerCommand("skill", {
    description: "Manage skills: panel (no args), create [name], lint [name], help",
    handler: async (args, ctx) => {
      const rest = args.trim();
      if (!rest) {
        await openPanel(pi, ctx, discoverSkills(ctx.cwd ?? process.cwd()));
        return;
      }
      const [sub, ...tail] = rest.split(/\s+/);
      if (sub === "help") {
        ctx.ui.notify(`Usage:\n  ${helpBody()}`, "info");
        return;
      }
      const cmd = SUBCOMMANDS.find((c) => c.name === sub);
      if (cmd) {
        await cmd.handler(tail.join(" "), ctx);
        return;
      }
      const tolerance = Math.max(2, Math.floor(sub.length / 3));
      const near = SUBCOMMANDS.map((c) => c.name).filter((n) => editDistance(sub, n) <= tolerance);
      ctx.ui.notify(
        `Unknown subcommand: ${sub}${near.length > 0 ? ` (did you mean: ${near.join(", ")}?)` : ""}\nUsage:\n  ${helpBody()}`,
        "error",
      );
    },
  });
}

// keep statSync referenced for potential future use (symlink handling)
void statSync;

/** Exposed for the smoke test only; not part of the extension surface. */
export const __test = {
  validateName,
  lintSkillEntry,
  scanAllForLint,
  scaffoldSkill,
  editDistance,
  helpBody,
  cmdCreate,
  cmdLint,
  PLACEHOLDER_DESCRIPTION,
  MAX_DESC,
};
