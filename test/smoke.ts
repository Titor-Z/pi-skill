/**
 * Smoke test for @foolsecret/pi-skill — MUST run with an isolated HOME:
 *
 *   HOME=$(mktemp -d) npx tsx test/smoke.ts
 *
 * Never run against the real $HOME: the test writes skill fixtures into
 * $HOME/.pi/agent/skills/ and (via the extension) reads ~/.pi/agent/settings.json.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import * as ext from "../extensions/skill-manager.ts";
const { __test } = ext as unknown as { __test: Record<string, any> };

let pass = 0;
let fail = 0;
function ok(cond: boolean | undefined, label: string): void {
  if (cond) {
    pass++;
    console.log(`  ok  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
  }
}

// ------------------------------------------------------------------ harness

interface Notify {
  msg: string;
  level: string;
}

interface Driver {
  ctx: { cwd: string; ui: any };
  notifications: Notify[];
  /** last component produced by ui.custom (null until one is opened) */
  component: any;
}

function makeDriver(cwd: string): Driver {
  const notifications: Notify[] = [];
  const driver: Driver = { ctx: null as any, notifications, component: null };
  driver.ctx = {
    cwd,
    ui: {
      notify(msg: string, level: string): void {
        notifications.push({ msg, level });
      },
      custom<T>(fn: (tui: any, theme: any, kb: any, done: (v: T) => void) => any): Promise<T> {
        return new Promise<T>((resolve) => {
          const tui = { requestRender(): void {} };
          const theme = {
            fg: (_role: string, s: string) => s,
            bold: (s: string) => s,
          };
          driver.component = fn(tui, theme, {}, resolve as (v: unknown) => void);
        });
      },
    },
  };
  return driver;
}

/** Register the extension against a stub API and return the /skill command handler. */
function loadHandler(): (args: string, ctx: any) => Promise<void> {
  let handler: ((args: string, ctx: any) => Promise<void>) | null = null;
  const pi = {
    registerCommand(name: string, cmd: { handler: (args: string, ctx: any) => Promise<void> }): void {
      if (name === "skill") handler = cmd.handler;
    },
  };
  (ext.default as unknown as (pi: unknown) => void)(pi);
  if (!handler) throw new Error("/skill command not registered");
  return handler;
}

const HOME = homedir();
const GLOBAL_SKILLS = join(HOME, ".pi", "agent", "skills");
const PROJECT = join(HOME, "project");
const PROJECT_SKILLS = join(PROJECT, ".pi", "skills");

// seed a settings.json with unrelated keys, to assert read-modify-write preserves them
mkdirSync(join(HOME, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(HOME, ".pi", "agent", "settings.json"),
  JSON.stringify({ model: "test-model", packages: ["./local-pkg"], skills: [] }, null, 2) + "\n",
);

function writeSkill(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "SKILL.md");
  writeFileSync(p, body);
  return p;
}

function lastNotify(d: Driver): Notify | undefined {
  return d.notifications[d.notifications.length - 1];
}

async function main(): Promise<void> {
  const { validateName, lintSkillEntry, scanAllForLint, scaffoldSkill, editDistance, helpBody, cmdCreate, cmdLint, argumentCompletions, PLACEHOLDER_DESCRIPTION, MAX_DESC } =
    __test;

  console.log("validateName");
  ok(validateName("foo").length === 0, "accepts lowercase name");
  ok(validateName("foo-bar-1").length === 0, "accepts hyphens and digits");
  ok(validateName("").some((e: string) => e.includes("lowercase")), "rejects empty");
  ok(validateName("-foo").some((e: string) => e.includes("start")), "rejects leading hyphen");
  ok(validateName("foo-").some((e: string) => e.includes("end")), "rejects trailing hyphen");
  ok(validateName("foo--bar").some((e: string) => e.includes("consecutive")), "rejects consecutive hyphens");
  ok(validateName("Foo").length > 0, "rejects uppercase");
  ok(validateName("foo bar").length > 0, "rejects spaces");
  ok(validateName("a".repeat(MAX_DESC)).length > 0, "rejects over-long name");

  console.log("helpBody / editDistance");
  const help = helpBody();
  ok(help.includes("/skill create [name]"), "help lists create");
  ok(help.includes("/skill lint [name]"), "help lists lint");
  ok(help.includes("/skill help"), "help lists help");
  ok(help.includes("open the skill management panel"), "help describes panel");
  ok(editDistance("crate", "create") === 1, "editDistance off-by-one");
  ok(editDistance("xyzzy", "create") > 2, "editDistance far strings");

  // ---------------------------------------------------------------- create

  console.log("/skill create <name>");
  const d1 = makeDriver(PROJECT);
  const handler = loadHandler();
  mkdirSync(GLOBAL_SKILLS, { recursive: true });
  await handler("create my-skill", d1.ctx);
  const created = join(GLOBAL_SKILLS, "my-skill", "SKILL.md");
  ok(existsSync(created), "scaffold written");
  ok(existsSync(join(GLOBAL_SKILLS, "my-skill", "references")), "references dir created");
  const createdText = readFileSync(created, "utf-8");
  ok(createdText.includes("name: my-skill"), "frontmatter name filled");
  ok(createdText.includes(`description: ${PLACEHOLDER_DESCRIPTION}`), "frontmatter placeholder description");
  ok(lastNotify(d1)?.level === "info", "create success notify");
  ok(lastNotify(d1)?.msg.includes(created), "create notify contains path");

  await handler("create my-skill", d1.ctx);
  ok(lastNotify(d1)?.level === "error" && lastNotify(d1)?.msg.includes("already exists"), "duplicate create rejected");

  await handler("create -bad", d1.ctx);
  ok(lastNotify(d1)?.level === "error" && lastNotify(d1)?.msg.includes("Invalid skill name"), "invalid name rejected");

  console.log("/skill create (wizard)");
  // cancel with Esc on step 1
  const d2 = makeDriver(PROJECT);
  const p2 = handler("create", d2.ctx);
  await Promise.resolve(); // let ui.custom run
  ok(d2.component !== null, "wizard opened");
  d2.component.handleInput("\x1b");
  await p2;
  ok(d2.notifications.length === 0, "cancel notifies nothing");
  ok(existsSync(join(GLOBAL_SKILLS, "my-skill", "SKILL.md")) && !existsSync(join(GLOBAL_SKILLS, "wiz")), "cancel writes nothing");

  // full happy path
  const d3 = makeDriver(PROJECT);
  const p3 = handler("create", d3.ctx);
  await Promise.resolve();
  d3.component.handleInput("w");
  d3.component.handleInput("i");
  d3.component.handleInput("z");
  let frame = (d3.component.render(60) as string[]).join("\n");
  ok(frame.includes("Name"), "step 1 shows name prompt");
  ok(frame.split("\n").every((l: string) => !l.includes("---")), "no --- separators in content");
  const footer = (d3.component.render(60) as string[]).filter((l: string) => l.includes("cancel"))[0] ?? "";
  ok(!footer.startsWith(" "), "footer has no left padding");
  d3.component.handleInput("\r"); // move to step 2
  frame = (d3.component.render(60) as string[]).join("\n");
  ok(frame.includes("Description") && frame.includes(`0/${MAX_DESC}`), "step 2 shows description prompt");
  for (const ch of "A test skill for the wizard") d3.component.handleInput(ch);
  d3.component.handleInput("\r");
  await p3;
  const made = join(GLOBAL_SKILLS, "wiz", "SKILL.md");
  ok(existsSync(made), "wizard creates SKILL.md");
  ok(readFileSync(made, "utf-8").includes("description: A test skill for the wizard"), "wizard description persisted");
  ok(lastNotify(d3)?.msg.includes(made), "wizard create notify contains path");

  // invalid name blocks submit
  const d4 = makeDriver(PROJECT);
  const p4 = handler("create", d4.ctx);
  await Promise.resolve();
  d4.component.handleInput("-");
  d4.component.handleInput("x");
  frame = (d4.component.render(60) as string[]).join("\n");
  ok(frame.includes("must not start"), "realtime name error rendered");
  d4.component.handleInput("\r");
  frame = (d4.component.render(60) as string[]).join("\n");
  ok(frame.includes("Name"), "Enter blocked on invalid name (still step 1)");
  d4.component.handleInput("\x1b");
  await p4;

  // over-long description blocks submit
  const d5 = makeDriver(PROJECT);
  const p5 = handler("create", d5.ctx);
  await Promise.resolve();
  d5.component.handleInput("t");
  d5.component.handleInput("o");
  d5.component.handleInput("o");
  d5.component.handleInput("\r");
  for (let i = 0; i < MAX_DESC + 1; i++) d5.component.handleInput("a");
  frame = (d5.component.render(60) as string[]).join("\n");
  ok(frame.includes(`description exceeds ${MAX_DESC} characters`), "realtime description length error rendered");
  d5.component.handleInput("\r");
  frame = (d5.component.render(60) as string[]).join("\n");
  ok(frame.includes("Description"), "Enter blocked on over-long description (still step 2)");
  d5.component.handleInput("\x1b");
  await p5;

  // ---------------------------------------------------------------- lint

  console.log("/skill lint");
  const d6 = makeDriver(PROJECT);
  rmSync(GLOBAL_SKILLS, { recursive: true, force: true });
  cmdLint("", d6.ctx);
  ok(lastNotify(d6)?.msg === "No skills found.", "lint with no skills");

  // good skill (global)
  writeSkill(join(GLOBAL_SKILLS, "good"), "good", `---\nname: good\ndescription: A good skill.\n---\n\n# good\n\nBody text.\n`);
  // missing frontmatter
  writeSkill(join(GLOBAL_SKILLS, "nofm"), "nofm", "# no frontmatter here\n");
  // invalid name
  writeSkill(join(GLOBAL_SKILLS, "badname"), "badname", `---\nname: Bad Name\ndescription: d.\n---\n\nbody\n`);
  // name/directory mismatch
  writeSkill(join(GLOBAL_SKILLS, "mismatch"), "mismatch", `---\nname: other\ndescription: d.\n---\n\nbody\n`);
  // over-long description
  writeSkill(
    join(GLOBAL_SKILLS, "longdesc"),
    "longdesc",
    `---\nname: longdesc\ndescription: ${"x".repeat(MAX_DESC + 1)}\n---\n\nbody\n`,
  );
  // empty body
  writeSkill(join(GLOBAL_SKILLS, "emptybody"), "emptybody", `---\nname: emptybody\ndescription: d.\n---\n`);
  // loose md, valid
  mkdirSync(GLOBAL_SKILLS, { recursive: true });
  writeFileSync(join(GLOBAL_SKILLS, "loose.md"), `---\nname: loose\ndescription: d.\n---\n\nbody\n`);
  // loose md with mismatched name
  writeFileSync(join(GLOBAL_SKILLS, "wrong.md"), `---\nname: notwrong\ndescription: d.\n---\n\nbody\n`);
  // project scope skill (broken: empty body, so it shows in the error report)
  writeSkill(join(PROJECT_SKILLS, "projskill"), "projskill", `---\nname: projskill\ndescription: d.\n---\n`);

  const entries = scanAllForLint(PROJECT);
  ok(entries.length === 9, `scanAllForLint finds all 9 fixtures (got ${entries.length})`);

  cmdLint("", d6.ctx);
  let msg = lastNotify(d6)?.msg ?? "";
  ok(lastNotify(d6)?.level === "error", "lint-all reports errors");
  ok(msg.includes("7/9 skills failed lint"), `lint-all counts 7/9 bad (got: ${msg.split("\n")[0]})`);
  ok(msg.includes("missing frontmatter"), "lint flags missing frontmatter");
  ok(msg.includes("lowercase"), "lint flags invalid name");
  ok(msg.includes('does not match directory "mismatch"'), "lint flags name/dir mismatch");
  ok(msg.includes(`description exceeds ${MAX_DESC}`), "lint flags over-long description");
  ok(msg.includes("empty body"), "lint flags empty body");
  ok(msg.includes('does not match file "wrong.md"'), "lint flags loose-md name mismatch");
  ok(msg.includes(join(PROJECT_SKILLS, "projskill")), "lint covers project scope");

  // single-skill lint
  const d7 = makeDriver(PROJECT);
  cmdLint("mismatch", d7.ctx);
  msg = lastNotify(d7)?.msg ?? "";
  ok(lastNotify(d7)?.level === "error" && msg.includes("mismatch") && !msg.includes("nofm"), "lint by name picks one skill");

  const d8 = makeDriver(PROJECT);
  cmdLint("good", d8.ctx);
  ok(lastNotify(d8)?.level === "info" && lastNotify(d8)?.msg.includes("1 skill OK"), "lint clean single skill");

  const d9 = makeDriver(PROJECT);
  cmdLint("no-such-skill", d9.ctx);
  ok(lastNotify(d9)?.msg.includes("No skill found: no-such-skill"), "lint unknown name");

  // lintSkillEntry direct: name vs loose file
  const looseBad = entries.find((e: any) => e.filePath.endsWith("wrong.md"));
  ok(lintSkillEntry(looseBad).some((e: string) => e.includes("does not match file")), "lintSkillEntry loose mismatch");

  // ---------------------------------------------------------------- dispatcher

  console.log("dispatcher");
  const d10 = makeDriver(PROJECT);
  await handler("cret", d10.ctx);
  ok(lastNotify(d10)?.level === "error" && lastNotify(d10)?.msg.includes("did you mean: create"), "unknown subcommand suggests");
  await handler("help", d10.ctx);
  ok(lastNotify(d10)?.level === "info" && lastNotify(d10)?.msg.includes("Usage:"), "/skill help prints usage");
  ok(scaffoldSkill("scaffolded", "d.").includes("scaffolded"), "scaffoldSkill returns path");

  // ---------------------------------------------------------------- panel (regression)

  console.log("/skill panel");
  const d11 = makeDriver(PROJECT);
  const p11 = handler("", d11.ctx);
  await Promise.resolve();
  ok(d11.component !== null, "panel opens with fixtures");
  const panel = (d11.component.render(80) as string[]).join("\n");
  ok(panel.includes("Skill Configuration"), "panel title");
  ok(panel.split("\n").every((l: string) => !l.includes("---")), "no --- separators in panel content");
  ok(panel.includes("(1/"), "position indicator present");
  // toggle the selected item: writes !name override into settings.skills
  const knownNames = new Set(scanAllForLint(PROJECT).filter((e: any) => e.name).map((e: any) => e.name));
  d11.component.handleInput("\r");
  const settingsTxt = readFileSync(join(HOME, ".pi", "agent", "settings.json"), "utf-8");
  const toggled = JSON.parse(settingsTxt).skills as string[];
  ok(toggled.length === 1 && toggled[0].startsWith("!") && knownNames.has(toggled[0].slice(1)), "toggle persists !name override");
  const settingsObj = JSON.parse(settingsTxt);
  ok(settingsObj.model === "test-model" && settingsObj.packages?.length === 1, "unrelated settings keys preserved");
  d11.component.handleInput("\x1b");
  await p11;

  console.log("argument completions");
  const ac = argumentCompletions;
  const top = ac("") ?? [];
  ok(top.length === 3 && top.map((i: any) => i.value).join(",") === "create ,lint ,help ", "empty args → all subcommands");
  ok((ac("cr") ?? []).map((i: any) => i.value).join() === "create ", "partial subcommand → filtered");
  ok(ac("bogus") === null, "unknown subcommand prefix → no completions");
  const lintAll = ac("lint ") ?? [];
  ok(lintAll.some((i: any) => i.value === "good" && i.description === "global"), "lint + space → skill names with scope");
  ok((ac("lint goo") ?? []).map((i: any) => i.value).join() === "good", "lint partial name → filtered");
  ok(ac("create x") === null, "create takes no second argument");
  ok(ac("lint nope-xyz") === null, "lint unknown name → no completions");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
