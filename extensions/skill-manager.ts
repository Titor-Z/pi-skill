/**
 * @foolsecret/pi-skill — skill manager for pi
 *
 * Commands:
 *   /skill                  Interactive panel: toggle skills on/off (space), save (enter)
 *   /skill new <name>       Scaffold a new skill in ~/.pi/agent/skills/<name>/
 *   /skill validate [name]  Validate a skill against the Agent Skills spec
 *
 * Enable/disable is stored in ~/.pi/agent/settings.json as `!pattern` override
 * entries in the `skills` array — pi's native resource enable/disable mechanism
 * (same one `pi config` uses). Takes effect after restart or /reload.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";


const MAX_NAME = 64;
const MAX_DESC = 1024;
const PANEL_MAX_VISIBLE = 16;

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
 * Toggle a skill in settings.skills by adding/removing a `!name` entry.
 * Other entries (extra search paths, unrelated overrides) are preserved.
 */
function setDisabled(skill: SkillEntry, disabled: boolean): void {
  const settings = readSettings();
  const list = settings.skills ?? [];
  const name = skill.name;
  // remove any override entries that reference this skill
  const cleaned = list.filter((p) => !patternMatches(p.replace(/^[!+-]/, ""), skill) || p.startsWith("+"));
  if (disabled) cleaned.push(`!${name}`);
  settings.skills = cleaned;
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + "\n");
}

// ---------------------------------------------------------------- panel UI

interface PanelResult {
  toggled: string[]; // names whose state changed (already persisted)
  cancelled: boolean;
}

function openPanel(pi: ExtensionAPI, ctx: ExtensionCommandContext, skills: SkillEntry[]): Promise<PanelResult | null> {
  const ui: ExtensionUIContext = ctx.ui;
  if (skills.length === 0) {
    ui.notify("No skills found.", "info");
    return Promise.resolve(null);
  }
  void pi;
  return ui.custom<PanelResult>((tui, theme, _kb, done) => {
      const settings = readSettings();
      const state = skills.map((s) => ({ skill: s, disabled: isDisabled(settings, s) }));
      const initial = new Map(state.map((s) => [s.skill.name, s.disabled]));
      let cursor = 0;

      const line = (text: string, width: number) => text.length > width ? text.slice(0, width - 1) + "…" : text;

      const component = {
        invalidate(): void {
          tui.requestRender();
        },
        render(width: number): string[] {
          const rows: string[] = [];
          rows.push(theme.bold("Skills") + theme.fg("dim", `  — space: toggle · enter: save · esc: cancel`));
          rows.push("");
          const visible = state.slice(0, PANEL_MAX_VISIBLE);
          for (let i = 0; i < visible.length; i++) {
            const { skill, disabled } = visible[i];
            const marker = i === cursor ? theme.fg("accent", "▸ ") : "  ";
            const box = disabled ? theme.fg("dim", "[x]") : theme.fg("success", "[ ]");
            const name = line(skill.name, 24).padEnd(24);
            const desc = line(skill.description || "(no description)", Math.max(10, width - 46));
            const scopeTag = theme.fg(skill.scope === "global" ? "dim" : "warning", skill.scope === "global" ? "global" : "project");
            const warn = skill.errors.length > 0 ? theme.fg("error", " ⚠") : "";
            const row = `${marker}${box} ${disabled ? theme.fg("dim", name) : name} ${theme.fg("dim", desc)}  ${scopeTag}${warn}`;
            rows.push(i === cursor ? theme.fg("accent", row) : row);
          }
          if (state.length > PANEL_MAX_VISIBLE) {
            rows.push(theme.fg("dim", `  … ${state.length - PANEL_MAX_VISIBLE} more (edit settings.json directly)`));
          }
          rows.push("");
          const sel = state[cursor]?.skill;
          if (sel?.errors.length) {
            rows.push(theme.fg("error", `⚠ ${sel.name}: ${sel.errors.join("; ")}`));
          }
          return rows;
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.up) || data === "k") {
            cursor = (cursor - 1 + state.length) % state.length;
            tui.requestRender();
          } else if (matchesKey(data, Key.down) || data === "j") {
            cursor = (cursor + 1) % state.length;
            tui.requestRender();
          } else if (matchesKey(data, Key.space)) {
            const entry = state[cursor];
            entry.disabled = !entry.disabled;
            setDisabled(entry.skill, entry.disabled);
            tui.requestRender();
          } else if (matchesKey(data, Key.enter)) {
            const toggled = state.filter((s) => s.disabled !== initial.get(s.skill.name)).map((s) => s.skill.name);
            done({ toggled, cancelled: false });
          } else if (matchesKey(data, Key.escape)) {
            done({ toggled: [], cancelled: true });
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
        const result = await openPanel(pi, ctx, skills);
        if (result && !result.cancelled) {
          const n = result.toggled.length;
          ctx.ui.notify(
            n > 0
              ? `Saved. ${n} skill${n > 1 ? "s" : ""} toggled: ${result.toggled.join(", ")}. Restart pi or /reload to apply.`
              : "No changes.",
            "info",
          );
        }
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
