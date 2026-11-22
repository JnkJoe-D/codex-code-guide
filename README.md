# Codex 代码导读 · Code Guide for Codex

在 VS Code 阅读代码时就地写批注，批量发给指定 Codex 桌面对话，在原位置看回答、跳转到引用并继续追问。可选的项目导读索引会按当前文件展示架构文档与入口。

## 安装和使用

1. 从 [GitHub Releases](https://github.com/JnkJoe-D/codex-code-guide/releases/latest) 下载 `.vsix`。在 VS Code 扩展面板选择「从 VSIX 安装」。有旧版 ZZZ 代码导读的用户可直接升级，原批注会保留。
2. 在 VS Code 打开要读的本地项目，在 Codex 桌面端打开同一个目录的对话。复制对话链接，执行命令「代码导读：绑定 Codex 对话」，粘贴链接或 UUID。绑定保存在本机的工作区状态里。
3. 可执行「安装 Codex 批注 Skill」将随插件发布的 Skill 安装到 `~/.agents/skills/code-guide-review`。也可以直接复制 [SKILL.md](skills/code-guide-review/SKILL.md)。如果已打开的对话暂时没有发现 Skill，收到的投递指令也包含必要的处理约定。
4. 选中代码，右键「添加走读批注」，保存正文。点纸飞机会发送当前工作区所有已保存的待提交批注。「仅当前文件」可从批注面板菜单或命令面板执行。
5. 回答自动出现在原批注下。可以在同一位置保存追问、查看回答的源码引用，或生成单独的修改请求草稿。确认草稿后可通过「发送当前修改请求草稿」单独提交。

投递依赖支持 `codex queue --thread … --resume` 的 Codex CLI，并使用目标对话的权限和模型。已安装 Codex 桌面端时会尝试自动发现 CLI。找不到时，运行「设置 Codex 命令位置」选择可信的 Codex 可执行文件。

## 投递和更新

- **已排队**表示 Codex 接受了消息，**处理中**表示对话开始读取批次，**已回答**表示 VS Code 已接收完整回复。当 CLI 无法在后台恢复对话时，扩展会尝试打开同一个 Codex 桌面对话，让它处理已排队的批次。这时 Codex 窗口可能被切到前台。确定需要重投时执行「重试未确认投递的批次」，也可复制原指令手动投递。
- 首次从 VSIX 安装后，扩展每天检查一次 [正式 GitHub Release](https://github.com/JnkJoe-D/codex-code-guide/releases/latest)。默认有新版时提醒。「设置 GitHub 自动更新」可切换为自动下载安装，或关闭检查。更新后重新加载 VS Code 窗口即可。扩展随版本携带 Skill，已经安装到 Codex 的副本可用安装命令更新。
- 自动更新源固定为本仓库正式发布的 VSIX，文件大小和 SHA-256 由扩展校验。编者可推送与 `package.json` 版本一致的 `vX.Y.Z` 标签，由 GitHub Actions 打包发布。
- 批次和回答写在项目的 `.tmp/zzz-code-review/` 下。从 VS Code 发送到目标 Codex 对话的是批次路径与处理请求。请在使用本工具的项目中将 `.tmp/zzz-code-review/` 加到 `.gitignore`。

单批约定见 [REVIEW_PROTOCOL.md](REVIEW_PROTOCOL.md)。插件在本地信任的 VS Code 工作区启动 Codex CLI。

## 可选的项目导读

在项目根目录创建 `.code-guide/navigation.json`。索引内的链接使用仓库相对路径，`anchor` 选填，可填写要查找的源码行或 Markdown 标题。

```json
{
    "topics": [
        {
            "id": "routing",
            "title": "路由",
            "match": ["src/routing/"],
            "intent": "在播放前统一裁决可用路由。",
            "read": [
                { "label": "入口", "path": "src/routing/main.ts", "anchor": "function start" }
            ],
            "docs": [
                { "label": "设计说明", "path": "docs/routing.md" }
            ]
        }
    ]
}
```

## English quick start

Install the VSIX from [Releases](https://github.com/JnkJoe-D/codex-code-guide/releases/latest). Open the same local folder in VS Code and in a Codex desktop conversation. Use the extension's command palette to bind the conversation using its `codex://threads/<id>` link. Annotate code, save your drafts, then click the paper plane to queue every saved draft in that workspace. Replies appear inline. The bundled [Skill](skills/code-guide-review/SKILL.md) is also available as a standalone install.

MIT · [License](LICENSE)
