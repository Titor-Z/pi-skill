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

交互布局对齐 pi 内置的 `/scoped-models` 选择器：居中滚动的视口、`(n/N)` 滚动位置指示、
选中项详情行、底部按键提示栏。列出 pi 所有能发现的 skill（全局 / 项目），
显示名称、来源与规范警告：

- 直接输入即模糊过滤（选中项详情行实时预览描述 / 规范错误）
- `↑` / `↓` 移动（首尾循环） · `Enter` 切换启用 / 禁用，**即时保存**，无需回车确认
- `Ctrl+A` 全部启用 · `Ctrl+X` 全部禁用（有过滤时仅作用于过滤结果）
- `Esc` 清空过滤（再按关闭面板）；设置中指向已不存在 skill 的残留条目会提示
  `Ctrl+D` 一键清理

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
