# 走读批注与 Codex 回填协议

VS Code 保存草稿，用户点纸飞机后，扩展把已保存的批注写到当前项目根目录的 `.tmp/zzz-code-review/<batchId>/request.json`，通过 `codex queue` 发送批次路径与处理指令。需要时也可以复制同一条投递指令。VS Code 与目标 Codex 对话使用同一工作区。

## Codex 处理批次

1. 核对请求归属的工作区、目录名和 `batchId`，读取用户指定的 `request.json`。协议值为 `zzz-code-review/v1`。每条问题有稳定的 `id`、仓库相对 `path`、`question`、`original` 和 `current`。可选的 `history` 是同一讨论的先前问题与回答，可选的 `sourceDigest` 是提交时归一化换行后的源文件 SHA-256。行号从 1 开始。`current` 为空表示没有找到唯一代码位置，回答前核对是否发生重命名、局部重构或换分支。
2. 对照当前源码和必要调用链。字段问题说明谁写入、谁消费、生命周期与单位。方法问题说明输入、状态变化和调用时机。设计取舍问题说明代码能证实的原因、替代设计的代价与判断依据。原始意图缺证据时明确区分代码事实与推测。
3. 查看当前项目的规范和模块说明，指出规范与实现的具体差异。逐条回答前，如果同批次的 `answers.json` 已完整有效，直接复用。否则写入 `status.json`，内容为 `{"protocol":"zzz-code-review/v1","batchId":"<batchId>","state":"processing"}`。
4. 把回答保存为请求同目录的 UTF-8 `answers.json`。先写同目录的临时文件再替换，避免编辑器读到未写完的 JSON。处理批次只写状态和回复，遇到需要修改的地方在回答中提出建议。

回答文件只接受此批次的批注 ID。每个问题恰好对应一条非空回答，`answer` 可包含 Markdown。

```json
{
  "protocol": "zzz-code-review/v1",
  "batchId": "照抄 request.json 的 batchId",
  "answers": [
    {
      "id": "照抄问题的 id",
      "answer": "直接解释该问题。",
      "references": [{ "path": "src/main.ts", "line": 10, "label": "调用入口" }]
    }
  ]
}
```

VS Code 监听状态和回答文件，自动将回复放在原批注下。`references` 可省略，它提供可跳转的仓库相对位置。源文件找不到唯一位置时，队列会打开原代码快照、问题和回答供人工核对。旧版 v1 文件仍可读取。
