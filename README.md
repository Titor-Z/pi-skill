# @foolsecret/pi-skill

[![npm](https://img.shields.io/npm/v/@foolsecret/pi-skill)](https://www.npmjs.com/package/@foolsecret/pi-skill)

Skill manager for [pi](https://pi.dev) — the missing front-end for your Agent Skills.

装了很多 skill 却记不清哪些还开着？`/skill` 一个面板全部搞定。

## 安装

```bash
pi install npm:@foolsecret/pi-skill
```

## 功能

### 🎛️ 交互面板 — `/skill`

列出 pi 所有能发现的 skill（全局 / 项目），显示名称、简介、来源与规范警告：

- `↑` / `↓`（或 `j` / `k`）移动 · `/` 搜索过滤
- `空格` 切换启用 / 禁用，**即时保存**，无需回车确认
- `Esc` / `q` 关闭（随时退出，状态已保存）；设置中指向已不存在 skill 的残留条目会提示 `c` 一键清理

禁用状态写入 `~/.pi/agent/settings.json` 的 `skills` 数组（`!名字` 覆盖条目）——
这是 pi 原生的资源开关机制（与 `pi config` 同源），不改文件名、不碰 skill 内容。
保存后重启 pi 或执行 `/reload` 生效。

### 🌱 脚手架 — `/skill new <name>`

按 [Agent Skills 规范](https://agentskills.io) 生成 skill 骨架（SKILL.md 模板 +
`references/` 目录），命名先校验后创建。

### ✅ 规范校验 — `/skill validate [name]`

检查 frontmatter 完整性、命名合法性（≤64 字符、小写 a-z/0-9/连字符）、描述长度
（≤1024 字符），问题逐条列出。

> 注：pi 内置的 `/skill:name` 命令（加载执行某个 skill）与本项目注册的 `/skill`
> 命令互不冲突。

## License

MIT
