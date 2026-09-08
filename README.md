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

详情区会智能排版：描述中的行内枚举（`(a) …` / `1. …` / `- …` 等）自动拆为
逐行列表显示，续行与条目文本对齐；普通描述则按宽度折行。

禁用状态写入 `~/.pi/agent/settings.json` 的 `skills` 数组（`!名字` 覆盖条目）——
这是 pi 原生的资源开关机制（与 `pi config` 同源），不改文件名、不碰 skill 内容。
注意：数组里只存覆盖指令，**数组为空即全部启用**——启用某个 skill 意味着移除
对应的 `!名字` 条目，而不是写入白名单。保存后重启 pi 或执行 `/reload` 生效。

### 🌱 脚手架 — `/skill create [name]`

按 [Agent Skills 规范](https://agentskills.io) 生成 skill 骨架（SKILL.md 模板 +
`references/` 目录），命名先校验后创建。不带参数时进入两步交互向导（对齐面板风格）：

- step 1 name：实时校验（小写 a-z/0-9/连字符、首尾连字符与连续连字符、≤64 字符、
  同名已存在），非法不挡输入但 Enter 拦截提交
- step 2 description：实时长度检测（n/1024，超限红字拦截）
- `Esc` 中止向导，不写盘；带参调用 `/skill create <name>` 跳过向导直接落盘

### 🔍 规范检查 — `/skill lint [name]`

对所有能发现的 skill（全局 / 项目）做确定性规范检查，只报 error 级：frontmatter
缺失、name 缺失或非法、name 与所在目录/文件名不一致、description 缺失或超长
（≤1024 字符）、正文为空。带参数只检查指定 skill，无参数全量检查；
`/skill help` 查看全部子命令。

> 注：pi 内置的 `/skill:name` 命令（加载执行某个 skill）与本项目注册的 `/skill`
> 命令互不冲突。

## 发布

发布由 GitHub Actions 完成，本地不需要 npm 登录态：

```bash
npm version patch        # 或 minor / major，同步 package.json 与 CHANGELOG
git push --follow-tags   # v* tag 触发 workflow：类型检查 → npm publish --provenance
```

tag 推送后 Actions 会自动执行类型检查并发布到 npm（带 provenance 供应鈥证明）；
也可在 Actions 页手动触发 `publish` 工作流并勾选 dry run 验证流程（不消耗版本号）。

## License

MIT
