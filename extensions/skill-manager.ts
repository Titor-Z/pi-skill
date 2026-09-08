/**
 * @foolsecret/pi-skill — skill manager for pi
 *
 * Commands:
 *   /skill                  Interactive panel: toggle skills on/off (enter, saved instantly)
 *   /skill new <name>       Scaffold a new skill in ~/.pi/agent/skills/<name>/
 *   /skill validate [name]  Validate a skill against the Agent Skills spec
 *
 * Enable/disable is stored in ~/.pi/agent/settings.json as `!pattern` override
 * entries in the `skills` array — pi's native resource enable/disable mechanism
 * (same one `pi config` uses). Takes effect after restart or /reload.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, getKeybindings, Key, matchesKey } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";


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

    const line = (text: string, width: number) => (text.length > width ? text.slice(0, width - 1) + "…" : text);

    const component = {
      invalidate(): void {
        tui.requestRender();
      },
      render(width: number): string[] {
        const items = filtered();
        if (cursor > items.length - 1) cursor = Math.max(0, items.length - 1);
        const enabled = state.filter((s) => !s.disabled).length;
        const rows: string[] = [];

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
          if (start > 0 || end < items.length) {
            rows.push(theme.fg("dim", `  (${cursor + 1}/${items.length})`));
          }
          rows.push("");
          // detail line for the selected skill
          const sel = items[cursor]?.skill;
          if (sel) {
            if (sel.errors.length > 0) {
              rows.push(theme.fg("error", line(`⚠ ${sel.name}: ${sel.errors.join("; ")}`, Math.max(20, width - 2))));
            } else {
              rows.push(theme.fg("dim", line(`  ${sel.description || "(no description)"}`, Math.max(20, width - 2))));
            }
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
        parts.push(`${enabled}/${state.length} enabled`);
        rows.push(theme.fg("dim", `  ${parts.join(" · ")}`));
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

// ---------------------------------------------------------------- extension

const NEW_TEMPLATE = (name: string) => `---
name: ${name}
description: What this skill does and when to use it. Be specific — the description decides when the agent loads it.
---

# ${name}

## Usage

Describe the workflow here. Reference relative paths from this skill directory, e.g.
[references/guide.md](references/guide.md).
`;

function validateSkillFile(skillPath: string): string[] {
  if (!existsSync(skillPath)) return [`not found: ${skillPath}`];
  let text: string;
  try {
    text = readFileSync(skillPath, "utf-8");
  } catch (e) {
    return [`cannot read: ${e}`];
  }
  const fm = parseFrontmatter(text);
  if (!fm) return ["missing frontmatter block (must start with `---` line)"];
  const errors: string[] = [];
  errors.push(...validateName(fm.name ?? "").map((e) => `name: ${e}`));
  const desc = fm.description ?? "";
  if (!desc.trim()) errors.push("description is required");
  else if (desc.length > MAX_DESC) errors.push(`description exceeds ${MAX_DESC} characters (${desc.length})`);
  return errors;
}

export default function skillManager(pi: ExtensionAPI) {
  pi.registerCommand("skill", {
    description: "Manage skills: panel (no args), new <name>, validate [name]",
    handler: async (args, ctx) => {
      const [sub, name] = args.trim().split(/\s+/);

      if (!sub) {
        const skills = discoverSkills(ctx.cwd ?? process.cwd());
        await openPanel(pi, ctx, skills);
        return;
      }

      if (sub === "new") {
        if (!name) {
          ctx.ui.notify("Usage: /skill new <name>  (lowercase a-z, 0-9, hyphens)", "warning");
          return;
        }
        const nameErrors = validateName(name);
        if (nameErrors.length > 0) {
          ctx.ui.notify(`Invalid skill name: ${nameErrors.join("; ")}`, "error");
          return;
        }
        const dir = join(homedir(), ".pi", "agent", "skills", name);
        const skillPath = join(dir, "SKILL.md");
        if (existsSync(skillPath)) {
          ctx.ui.notify(`Skill already exists: ${skillPath}`, "error");
          return;
        }
        mkdirSync(join(dir, "references"), { recursive: true });
        writeFileSync(skillPath, NEW_TEMPLATE(name));
        ctx.ui.notify(`Created skill scaffold: ${skillPath}`, "info");
        return;
      }

      if (sub === "validate") {
        const target = name
          ? join(homedir(), ".pi", "agent", "skills", name, "SKILL.md")
          : join(homedir(), ".pi", "agent", "skills", "SKILL.md");
        const errors = validateSkillFile(target);
        if (errors.length === 0) ctx.ui.notify(`OK: ${target}`, "info");
        else ctx.ui.notify(`${target}\n  - ${errors.join("\n  - ")}`, "error");
        return;
      }

      ctx.ui.notify(
        "Usage:\n  /skill                open the skill management panel\n  /skill new <name>     scaffold a new skill\n  /skill validate [name]  validate against the spec",
        "info",
      );
    },
  });
}

// keep statSync/basename referenced for potential future use (symlink handling)
void statSync;
void basename;
