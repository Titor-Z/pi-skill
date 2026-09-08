# AGENTS.md — pi-skill 项目协作文档

本文件由人类与 agent 共同维护，包含三个固定章节。每次开发对话后必须更新。

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

---

## 项目进度

### 已完成

- [x] 调研 pi skill 发现规则与禁用机制（源码级确认）
- [x] 首版脚手架/校验扩展（`/skills new`、`/skills validate`）+ 冒烟测试通过
- [x] npm 名称可用性探测，定名 `@foolsecret/pi-skill`
- [x] 项目骨架：git 仓库、package.json（pi manifest + peerDependencies）
- [x] AGENTS.md、CHANGELOG.md、README.md
- [x] `/skill` 交互面板（列表、空格切换、回车保存、Esc 取消）
- [x] 子命令整合：`/skill new`、`/skill validate`
- [x] 旧扩展文件清理（`~/.pi/agent/extensions/skill-manager.ts` 已删除，改由包加载）
- [x] `pi install ~/projects/pi-skill` 本地注册（settings.packages 引用本地包路径，启动无报错）
### 待办

- [ ] `pi -e ~/projects/pi-skill` 本地实机验证
- [ ] 发布准备：`files` 白名单、LICENSE、`npm publish --access public`
- [ ] 项目级（project scope）开关支持（写 `.pi/settings.json`，类似 `pi config` 的 Tab 切换）
- [ ] 冲突检测：同名 skill 多来源时的提示（pi 保留先发现者）
- [ ] skill 安装/卸载（`/skill install <git-url|npm>`）
- [ ] 面板超过 16 项时的滚动（当前提示直接编辑 settings.json）

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

### 知识点 8：toggle 提示信息要与"面板初始状态"比较

面板中每次空格切换都立即持久化到 settings.json，因此"保存后报告改了哪些项"必须与面板打开时的初始状态快照对比，而不是与实时的 settings 内容对比——否则永远显示"无变化"。

### 知识点 9：本地包注册用 `pi install <目录路径>`

本地目录包应通过 `pi install ~/projects/pi-skill` 注册（写入 settings 的 `packages` 数组，相对路径相对 `~/.pi/agent` 解析），而不是手动往 `extensions` 数组里塞目录——前者走包规则（`pi` manifest、约定目录发现），后者只加载单个扩展文件。
