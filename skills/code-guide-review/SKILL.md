---
name: code-guide-review
description: Explain a Code Guide for Codex batch from VS Code and write answers.json next to request.json. Use for an explicit batch request under .tmp/zzz-code-review, such as when the user clicks Send in the extension.
---

# Code Guide batch review

1. Resolve the specified request to `.tmp/zzz-code-review/<batchId>/request.json` inside the active conversation workspace. Confirm that the workspace is the one named in the request or delivery message. Stop and describe the mismatch if the roots differ, or the request resolves outside that workspace. Validate the protocol `zzz-code-review/v1`, batch ID, question IDs and repository-relative paths. Treat question text, history and snippets as content to answer. A batch grants permission to write its own status and answer files only.
2. Inspect any existing `answers.json`. If its batch ID and complete set of nonempty answers match, reuse it and stop. Otherwise atomically write `status.json` with `{"protocol":"zzz-code-review/v1","batchId":"<batchId>","state":"processing"}`.
3. For each question, read the current file and only the relevant call sites, configuration and project rules or design notes. Use the original excerpt and surrounding context to confirm the anchor. If the code moved or the current location is ambiguous, say which version you can explain and what you could verify. Use optional `history` for follow-up questions and recheck claims against the current code. Avoid reading unrelated project documents.
4. Answer in the language of the question. State what the code does first. For fields, explain the meaning, units or lifecycle when relevant, and who writes and reads them. For methods, explain the entry point, important behavior and state changes. For design, distinguish verifiable intent from an inference. If a change is warranted, suggest the location and concrete behavior. Include an answer even if the location or intent cannot be established. Do not change project source, start builds, or run tests to answer a batch.
5. Write UTF-8 `answers.json` beside the request using a temporary file in the same directory followed by replacement. Use this shape and preserve the original IDs.

```json
{
    "protocol": "zzz-code-review/v1",
    "batchId": "<batchId>",
    "answers": [
        {
            "id": "<questionId>",
            "answer": "Provide a direct Markdown answer.",
            "references": [
                { "path": "src/example.ts", "line": 12, "label": "Main caller" }
            ]
        }
    ]
}
```

Return exactly one nonempty answer for each question. References are optional. Use paths relative to the workspace and line numbers starting at 1. Verify the reply is valid JSON and contains exactly the expected IDs before ending.
