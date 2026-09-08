# AGENTS.md — pi-skill 项目协作文档

本文件由人类与 agent 共同维护，包含四个固定章节（讨论记录、项目进度、认知纠正、开发规范）。每次开发对话后必须更新。

---

## 讨论记录 (taolun)

每轮对话精炼为陈述句报告，按日期倒序追加。

### 2026-09-08 会话 1 — design.md skill 的启示

- 用户认为 google-labs-code/design.md 仓库的 CLI（lint/diff）不好用，其真正价值在于"让 agent 遵守设计规范写 UI"和"把网站反推归纳成规范格式"两个场景，适合做成 agent skill 而非 CLI 工具。
- 据此创建了 design-md skill（`~/.pi/agent/skills/design-md/`），含 SKILL.md 工作流 + references/spec.md 全量规范，渐进式披露。

### 2026-09-08 会话 2 — 从 skill 管理需求到 pi-skill 包

- 用户提出 pi 缺少 skills 的全局管理能力；经讨论确定 extensions 与 skills 性质不同（前者是可执行代码涉及信任与重载，后者是纯 Markdown 数据），决定只做 skill 管理，MCP 暂不做。
- 首版实现 `~/.pi/agent/extensions/skill-manager.ts`（`/skills new`、`/skills validate`）并通过冒烟测试。
- 调研确认：pi 的 skill 发现规则为递归查找含 SKILL.md 的目录（命中即停）、全局目录散 .md 也算、跳过 node_modules 与隐藏目录、遵守 gitignore 系文件；pi 无独立的"禁用开关"设置。
- 用户提出名单制禁用方案（类似 /model 选择器，空格切换），拒绝改文件名方案。
- 源码调研结论：pi settings 的 `skills` 数组具有双重语义——既是附加搜索路径，又支持 `!pattern`/`+path`/`-path` 覆盖条目，`isEnabledByOverrides` 按 basename/相对路径 glob 匹配，对用户目录、`.agents/skills`、项目目录全部生效；pi 自带 `pi config` 也基于此机制。因此名单直接存放在 `~/.pi/agent/settings.json` 的 `skills` 数组中，由 pi 原生强制执行。
- npm 名称探测：`pi-skiller` 未被占用但与现有 `skiller` 包（zbeyens）名字相近；`pi-skill-manager`、`pi-skills-manager` 已被占用；最终定名 `@foolsecret/pi-skill`。
- 项目命令定为 `/skill`（无参数进入交互面板，与 pi 内置的 `/skill:name` 命令空间不冲突）；项目位于 `~/projects/pi-skill/`，计划以 npm 包发布。

### 2026-09-08 会话 3 — 对齐 /scoped-models 的即时保存交互

- 用户提出模仿 pi 内置 `/scoped-models` 的交互：空格即切换即持久化，去掉回车确认语义；同时保留搜索过滤等增强。
- 已重构 openPanel：两态输入（浏览/搜索）、统计行、滚动 viewport、切换即时落盘 + 页脚 `skill → state ✓` 反馈、`c` 清理残留 `!条目`；README/CHANGELOG 同步，冒烟测试全过。

---

### 2026-09-08 会话 4 — settings.json 被重置的事故归因与开发规范

- 用户报告每次开发后 `~/.pi/agent/settings.json` 都被重置、已启用的 packages 被删。归因结论：插件自身的代码路径（setDisabled、残留清理均为读-改-写，保留其他键）没有删过 packages；重置来自历次开发会话对真实 settings.json 的直接改写——session 日志中找到三处证据（2026-09-05 pi-usager 会话、2026-09-06 pi-glmbridger 会话的 .bak 备份+删键、2026-09-08 本项目会话冒烟测试时 `d['skills']=[]` 清空 skills 数组）。
- 顺带审查出插件 settings 写入的三个隐患：readSettings 吞掉 JSON 解析错误返回 `{}`（随后一次写入即覆写全文件）、写入非原子且不加 pi 使用的 proper-lockfile 锁、setDisabled 的清理逻辑会把 skills 数组里的普通搜索路径条目（非覆盖条目，如 `"design-md"`）误当开关删除。
- 用户决定：本次只做记录，在 AGENTS.md 新增"开发规范"章节，明确不允许 agent 随意修改用户真实开发环境；隐患修复留待后续。

---

### 2026-09-08 会话 5 — 面板重设计：逐项对齐 /scoped-models

- 用户提出用内置 `/scoped-models` 选择器的样式重做 `/skill` 面板。决策：只搬视觉与交互，保留即时保存——"session-only + Ctrl+S"语义对 skill 不可行（pi 只在启动/reload 时加载 skills，extension 无运行时干预钩子，会话 2 已调研过）。
- 研读了 pi 的 `ScopedModelsSelectorComponent` 参考实现（dist/modes/interactive/components/），逐元素对齐：居中滚动视口、`(n/N)` 指示、选中项详情行、底部按键提示栏（`getKeybindings().getKeys()` 读取用户实际键位）、`fuzzyFilter` 模糊搜索、单焦点输入（直接打字即过滤，Esc 先清过滤再关闭）、Ctrl+A/Ctrl+X 批量启用/禁用（作用于过滤结果）。
- 顺带修掉了会话 4 发现的三个隐患之一：`setDisabled` 重写为只增删精确 `!名字` 条目（Set 操作），不再碰普通搜索路径条目；残留清理迁移到 Ctrl+D 且只删 `!` 前缀条目。剩余两隐患（fail-closed 读入、原子写+锁）待办中。
- 冒烟测试验证了开发规范：`HOME=$(mktemp -d)` 隔离跑 tsx，39 项断言全过，并直接断言"真实 settings.json 未被触碰"。两个教训：① 测试断言要跟实现语义对齐（滚动指示器只在超出视口时出现、toggle 不移动光标）；② 项目 node_modules 的 pi-tui stub 需随新 API 同步补齐（fuzzyFilter/getKeybindings/Key.ctrl）。
- README/CHANGELOG 同步，含 setDisabled 误删修复的 Fixed 条目。

---

## 项目进度

### 已完成

- [x] 调研 pi skill 发现规则与禁用机制（源码级确认）
- [x] 首版脚手架/校验扩展（`/skills new`、`/skills validate`）+ 冒烟测试通过
- [x] npm 名称可用性探测，定名 `@foolsecret/pi-skill`
- [x] 项目骨架：git 仓库、package.json（pi manifest + peerDependencies）
- [x] AGENTS.md、CHANGELOG.md、README.md
- [x] `/skill` 交互面板（列表、空格切换、Esc 取消）
- [x] 子命令整合：`/skill new`、`/skill validate`
- [x] 旧扩展文件清理（`~/.pi/agent/extensions/skill-manager.ts` 已删除，改由包加载）
- [x] `pi install ~/projects/pi-skill` 本地注册（settings.packages 引用本地包路径，启动无报错）
- [x] 面板交互重设计：即时保存、搜索过滤、统计行、viewport 滚动、残留清理
- [x] 面板视觉重设计：逐项对齐 /scoped-models（滚动视口、详情行、键位提示栏、fuzzyFilter、批量操作）；修复 setDisabled 误删搜索路径条目

### 待办

- [ ] `pi -e ~/projects/pi-skill` 本地实机验证
- [ ] 发布准备：`files` 白名单、LICENSE、`npm publish --access public`
- [ ] 项目级（project scope）开关支持（写 `.pi/settings.json`，类似 `pi config` 的 Tab 切换）
- [ ] 冲突检测：同名 skill 多来源时的提示（pi 保留先发现者）
- [ ] skill 安装/卸载（`/skill install <git-url|npm>`）
- [ ] 修复插件 settings 写入的剩余两个隐患：readSettings 解析失败 fail-closed（拒绝写入而非返回空对象）、原子写（tmp+rename）+ proper-lockfile 锁（精确 `!条目` 一项已在会话 5 完成）

---

## 认知纠正

踩坑记录，以知识点报告形式编写。

### 知识点 1：pi settings 的 `skills` 数组具有双重语义

`~/.pi/agent/settings.json` 的 `skills` 字段不只是"附加搜索路径"。以 `!`、`+`、`-` 开头的条目是覆盖指令：`!pattern` 全局禁用（按 basename 或相对路径 minimatch 匹配，对 SKILL.md 会同时匹配其父目录名），`+path` 强制包含，`-path` 强制排除。该机制对自动发现目录（`~/.pi/agent/skills/`、`~/.agents/skills/`、项目 `.pi/skills/`、`.agents/skills/`）和包内资源统一生效。pi 自带的 `pi config` 命令写的也是同一机制。

### 知识点 2：pi 没有独立的"禁用 skill"设置键

不存在 `disabledSkills` 之类的键。所有资源（extensions/skills/prompts/themes）的启停都通过各自路径数组中的覆盖条目表达。扩展若要提供开关 UI，正确做法是增删 settings 数组中的 `!名字` 条目，而不是发明新配置格式。

### 知识点 3：skill 扫描器的边界行为

递归扫描遇到含 SKILL.md 的目录即停止下钻（skill 内的 node_modules 不会被扫描）；根目录的散 `.md` 仅在 `~/.pi/agent/skills/` 和 `.pi/skills/` 被视为 skill；隐藏目录一律跳过；`.gitignore`/`.ignore`/`.fdignore` 在扫描时生效。改名为 `SKILL.md.disabled` 虽能禁用但破坏跨 harness 兼容，应优先使用 settings 覆盖条目。

### 知识点 4：scoped npm 包发布需要 `--access public`

`npm publish` 默认把 scoped 包发布为私有（需要付费账号），必须显式 `npm publish --access public`。

### 知识点 5：pi 扩展的同名命令冲突

两个扩展注册同名命令时 pi 会告警并保留先加载者。全局 `~/.pi/agent/extensions/` 与包内扩展同时注册 `/skill` 会导致行为不确定，迁移到包之后必须删除旧文件。

### 知识点 6：pi 包的依赖声明规则

扩展可 import 的共享库（`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`、`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`）由 pi 运行时提供，包内必须放 `peerDependencies`（range 为 `*`）且不得打包；其他第三方运行时依赖放 `dependencies`（git 包安装时会执行 `npm install`）。

### 知识点 7：本地 TypeScript 运行时与 tsconfig paths 的冲突

用 tsx 做冒烟测试时，tsconfig `paths` 指向的 `.d.ts` 会被 tsx 当作运行时模块编译（其内部 `import "./x.ts"` 解析失败）。解决办法：测试时用 `TSX_TSCONFIG_PATH` 指向一份无 paths 的精简 tsconfig，同时在项目 node_modules 里放置 pi 模块的运行时 stub。注意 stub 会污染 `npm publish`，发布必须用 `files` 白名单。

### 知识点 8：toggle 状态报告的基准（历史：已由即时保存取代）

首版面板采用"回车批量保存"时，变更报告曾错误地与实时 settings 对比导致永远显示"无变化"；必须与面板打开时的快照对比。重构为即时保存后此问题消失，但若未来引入批量操作，仍需注意快照基准。

### 知识点 9：本地包注册用 `pi install <目录路径>`

本地目录包应通过 `pi install ~/projects/pi-skill` 注册（写入 settings 的 `packages` 数组，相对路径相对 `~/.pi/agent` 解析），而不是手动往 `extensions` 数组里塞目录——前者走包规则（`pi` manifest、约定目录发现），后者只加载单个扩展文件。

---

## 开发规范

本节由 2026-09-08 会话 4 的 settings.json 重置事故直接促成，优先级高于其他惯例。历史教训：历次开发会话曾为冒烟测试/配置迁移直接改写用户真实的 `~/.pi/agent/settings.json`（清空 skills 数组、删除 modelThinkingLevels/retry 等键），造成用户配置丢失。

### 禁止修改用户真实环境

- 用户真实环境中的配置与数据文件属于用户资产，不是项目产物，**一律不得直接修改、删除、清空**。包括但不限于：`~/.pi/agent/settings.json`、`~/.pi/agent/auth.json`、`~/.pi/agent/models-store.json`、`~/.pi/agent/skills/`、`~/.pi/agent/extensions/`、`~/.pi/agent/npm/`、shell 配置（`.zshrc` 等）。
- 即使是"看起来无害的键值微调"也不允许——测试遗留写入与"临时"删键正是本次事故的根源。

### 测试必须隔离

- 凡涉及读/写用户级目录的代码（如本项目扩展通过 `os.homedir()` 定位 settings.json），冒烟测试必须在隔离环境中运行：POSIX 下设置 `HOME` 指向临时目录（如 `HOME=/tmp/pi-skill-test-$(date +%s)`）再跑 tsx，或改用临时目录 + 依赖注入。
- 严禁为了"构造测试场景"而用脚本（python3/node/jq 等）改写真实配置文件。

### 确需改动时：先问、先备份、后记录

- 确有正当理由需要改动用户真实环境（且是用户明确要求的），必须先说明改动内容与影响范围，征得用户同意后才能执行。
- 执行前必须备份（如 `cp settings.json settings.json.bak`），执行后在对话与 AGENTS.md 中记录改了什么、为什么改。

### 只用官方命令

- 能用官方命令完成的操作，不许用脚本直接改写其配置文件：包的装/卸/启用用 `pi install` / `pi remove` / `pi config`，不要手写 settings.json 的 `packages`/`skills` 数组。

### 插件自身的健壮性义务

- 扩展写用户配置时必须：read-modify-write 并保留全部未知字段；解析失败时 fail-closed（拒绝写入并报错，绝不基于空对象覆写）；原子写（tmp 文件 + rename）并加与 pi 一致的文件锁；只增删自己拥有的条目，不动用户的其他配置。
