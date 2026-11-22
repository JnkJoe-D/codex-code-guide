const vscode = require('vscode');
const { randomUUID } = require('node:crypto');
const { executableFor, deliver } = require('./codexTransport');
const {
    inbox, protocol, relativeSource, safeSourcePath, makeAnchor, locateAnchor, statusOf, validateAnswers,
    promptFor, sourceDigest, threadIdFor
} = require('./reviewData');

const prefix = 'zzzReview.';
const stateKey = 'zzzReview.notes.v1';
const targetKey = 'codeGuide.codexTargets';
const deliveryKey = 'codeGuide.deliveries';
const cliKey = 'codeGuide.codexExecutable';
const deliveryLabels = {
    queued: '已排队', processing: '处理中', failed: '投递失败', unknown: '投递状态不明'
};
const presets = [
    { label: '字段／参数含义', text: '这个字段或参数表示什么？它由谁写入、在哪里读取？' },
    { label: '方法职责', text: '这个方法负责什么？它由谁调用，会改变哪些状态？' },
    { label: '设计取舍', text: '这里为什么采用当前设计？常见替代方案的利弊是什么？' },
    { label: '潜在问题', text: '这段实现在哪些情况下可能出错？现有调用方是否会触发？' }
];

function activateReview(context) {
    const review = new Review(context.workspaceState, context.globalState);
    const view = vscode.window.createTreeView('zzzCodeGuide.review', { treeDataProvider: review });
    const refreshSummary = () => {
        const root = activeRoot();
        const count = review.workspaceNotes().filter(note => !note.batch && (!root || note.root === root)).length;
        view.description = count ? count + ' 条待提交' : undefined;
        const target = review.targets[root];
        view.message = target ? '发送到 ' + target.label : '请先绑定 Codex 对话。';
    };
    const command = (id, action) => vscode.commands.registerCommand(prefix + id, (...args) =>
        review.run(() => action(...args)));
    context.subscriptions.push(
        review, view,
        command('add', () => review.add()),
        command('addPreset', () => review.add(true)),
        command('save', input => review.save(input)),
        command('edit', thread => review.edit(thread)),
        command('cancel', input => review.cancel(input)),
        command('remove', thread => review.remove(thread)),
        command('close', thread => review.close(thread)),
        command('open', note => review.open(note)),
        command('submitFile', uri => review.submit(false, uri)),
        command('submitWorkspace', () => review.submit(true)),
        command('bind', () => review.bind()),
        command('openTarget', () => review.openTarget()),
        command('setCli', () => review.setCli()),
        command('retry', () => review.retry()),
        command('reply', value => review.reply(value)),
        command('references', input => review.openReference(input?.noteId)),
        command('draftTask', thread => review.draftTask(thread)),
        command('sendTaskDraft', () => review.sendTaskDraft()),
        command('copy', () => review.copy()),
        command('refresh', () => review.refreshAnswers()),
        review.onDidChangeTreeData(refreshSummary),
        vscode.window.onDidChangeActiveTextEditor(refreshSummary),
        vscode.workspace.onDidChangeWorkspaceFolders(() => review.run(async () => {
            review.updateWatchers();
            await review.refreshAnswers();
        })),
        vscode.workspace.onDidOpenTextDocument(doc => review.syncDocument(doc)),
        vscode.workspace.onDidSaveTextDocument(doc => review.syncDocument(doc)),
        vscode.workspace.onDidCloseTextDocument(doc => review.releaseDocument(doc))
    );

    review.updateWatchers();
    refreshSummary();
    review.run(() => review.refreshAnswers());
}

class Review {
    constructor(storage, globalState) {
        this.storage = storage;
        this.globalState = globalState;
        this.notes = storage.get(stateKey, []);
        this.targets = storage.get(targetKey, {});
        this.deliveries = storage.get(deliveryKey, {});
        this.answers = new Map();
        this.references = new Map();
        this.processing = new Set();
        this.digests = new WeakMap();
        this.taskDrafts = new Map();
        this.errors = new Map();
        this.threads = new Map();
        this.editing = new Map();
        this.watchers = [];
        this.pending = Promise.resolve();
        this.events = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.events.event;
        this.controller = vscode.comments.createCommentController('zzzCodeReview', '代码走读批注');
        this.controller.options = { prompt: '写下你的问题', placeHolder: '例如：为何这里要再乘一次倍率？' };
    }

    // 串行提交本地状态，避免连续点击或文件监听回调覆盖草稿。
    run(action) {
        const next = this.pending.then(action);
        this.pending = next.catch(error => {
            vscode.window.showWarningMessage('代码批注：' + error.message);
        });
        return this.pending;
    }

    dispose() {
        this.watchers.forEach(watcher => watcher.dispose());
        this.controller.dispose();
        this.events.dispose();
    }

    updateWatchers() {
        this.watchers.forEach(watcher => watcher.dispose());
        this.watchers = localFolders().map(folder => {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(folder, inbox + '/*/{answers,status}.json')
            );
            const refresh = () => this.run(() => this.refreshAnswers());
            watcher.onDidCreate(refresh);
            watcher.onDidChange(refresh);
            watcher.onDidDelete(refresh);
            return watcher;
        });
    }

    getTreeItem(item) {
        return item.tree;
    }

    getChildren(item) {
        if (item) return item.children ?? [];
        const notes = this.workspaceNotes();
        const groups = Object.entries({
            草稿: 'comment', 已排队: 'clock', 处理中: 'sync', 待回答: 'clock',
            投递失败: 'warning', 投递状态不明: 'question', 已回答: 'check', 已关闭: 'archive'
        });
        const result = [];
        for (const [status, icon] of groups) {
            const entries = notes.filter(note => this.noteStatus(note) === status);
            if (entries.length === 0) continue;
            const files = new Map();
            for (const note of entries) {
                const key = note.root + '\n' + note.path;
                if (!files.has(key)) files.set(key, []);
                files.get(key).push(note);
            }
            const paths = [...files.values()].map(fileNotes => {
                const path = fileNotes[0].path;
                const children = fileNotes.sort((a, b) => a.anchor.line - b.anchor.line).map(note => {
                    const label = note.question.split('\n')[0];
                    const row = treeRow(label, 'comment');
                    row.tree.description = 'L' + note.anchor.line;
                    row.tree.tooltip = [note.question, this.deliveries[note.batch]?.diagnostic].filter(Boolean).join('\n\n');
                    row.tree.command = { command: prefix + 'open', title: '查看批注', arguments: [note] };
                    return row;
                });
                const row = treeRow(path.split('/').at(-1), 'symbol-file', children, status !== '已关闭');
                row.tree.tooltip = path;
                return row;
            });
            result.push(treeRow(status + ' (' + entries.length + ')', icon, paths, status !== '已关闭'));
        }
        for (const message of this.errors.values()) {
            const row = treeRow('回答文件暂无法读取', 'warning');
            row.tree.tooltip = message;
            result.push(row);
        }
        return result.length ? result : [treeRow('选中代码，右键添加走读批注。', 'info')];
    }

    noteStatus(note) {
        const state = this.processing.has(note.batch) ? 'processing' : this.deliveries[note.batch]?.state;
        return statusOf(note, this.answers.get(note.id), deliveryLabels[state]);
    }

    workspaceNotes() {
        const roots = new Set(localFolders().map(folder => folder.uri.fsPath));
        return this.notes.filter(note => roots.has(note.root));
    }

    async add(usePreset = false) {
        const editor = vscode.window.activeTextEditor;
        const doc = editor?.document;
        const location = sourceLocation(doc?.uri);
        if (!location) throw new Error('请先在打开的本地工作区选择代码。');

        const selection = editor.selection;
        const start = selection.start.line;
        const end = selection.end.line > start && selection.end.character === 0
            ? selection.end.line - 1 : selection.end.line;
        const anchor = makeAnchor(documentLines(doc), start, end);
        if (!anchor.code.trim()) throw new Error('请选择实际代码或把光标放在有代码的行。');

        let text = '';
        if (usePreset) {
            const preset = await vscode.window.showQuickPick(
                presets.map(item => ({ ...item, description: item.text })),
                { placeHolder: '选择预填内容，之后可直接修改' }
            );
            if (!preset) return;
            text = preset.text;
        }
        const range = rangeAt(doc, { start, end });
        const note = { id: randomUUID(), ...location, anchor, createdAt: new Date().toISOString() };
        const input = editingComment(comment(text, '我的批注'), note.id);
        const thread = this.controller.createCommentThread(doc.uri, range, [input]);
        this.editing.set(note.id, { thread, note, input });
        thread.canReply = false;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }

    async save(input) {
        const edit = this.editing.get(input?.noteId);
        if (!edit || edit.input !== input) throw new Error('这个编辑框已失效，请重新打开批注。');
        const body = typeof input.body === 'string' ? input.body : input.body.value;
        const question = body.trim();
        if (!question) {
            this.cancel(input);
            throw new Error('批注内容不能为空。');
        }

        const existing = this.notes.find(note => note.id === edit.note.id);
        const note = { ...edit.note, question };
        const updated = existing
            ? this.notes.map(current => current.id === note.id ? note : current)
            : [...this.notes, note];
        await this.persist(updated);
        this.editing.delete(note.id);
        this.threads.set(note.id, edit.thread);
        this.renderThread(edit.thread, note);
        this.events.fire();
    }

    edit(thread) {
        const note = this.threadNote(thread);
        if (!note || note.batch || this.editing.has(note.id)) return;
        const input = editingComment(thread.comments[0], note.id);
        this.editing.set(note.id, { thread, note, input });
        thread.contextValue = undefined;
        thread.comments = [input];
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }

    cancel(input) {
        const edit = this.editing.get(input?.noteId);
        if (!edit || edit.input !== input) return;
        this.editing.delete(edit.note.id);
        const saved = this.notes.find(note => note.id === edit.note.id);
        if (saved) this.renderThread(edit.thread, saved);
        else edit.thread.dispose();
    }

    async remove(thread) {
        const note = this.threadNote(thread);
        if (!note || note.batch) return;
        await this.persist(this.notes.filter(current => current.id !== note.id));
        this.editing.delete(note.id);
        this.threads.delete(note.id);
        thread.dispose();
        this.events.fire();
    }

    async close(thread) {
        const note = this.threadNote(thread);
        if (!note || !this.answers.has(note.id)) return;
        const closed = { ...note, resolved: true };
        await this.persist(this.notes.map(current => current.id === note.id ? closed : current));
        this.renderThread(thread, closed);
        this.events.fire();
    }

    threadNote(thread) {
        return this.notes.find(note => this.threads.get(note.id) === thread);
    }

    async persist(notes) {
        await this.storage.update(stateKey, notes);
        this.notes = notes;
    }

    syncDocument(doc) {
        const place = sourceLocation(doc.uri);
        if (!place) return;
        const notes = this.notes.filter(note => !note.parentId && note.root === place.root && note.path === place.path);
        if (notes.length === 0) return;
        const lines = documentLines(doc);
        for (const note of notes) {
            let thread = this.threads.get(note.id);
            if (this.editing.has(note.id)) continue;
            const location = locateAnchor(lines, note.anchor);
            if (!location) {
                thread?.dispose();
                this.threads.delete(note.id);
                continue;
            }
            const range = rangeAt(doc, location);
            if (!thread) {
                thread = this.controller.createCommentThread(doc.uri, range, []);
                this.threads.set(note.id, thread);
            }
            thread.range = range;
            this.renderThread(thread, note);
        }
    }

    releaseDocument(doc) {
        const uri = doc.uri.toString();
        this.taskDrafts.delete(uri);
        for (const [id, edit] of this.editing) {
            if (edit.thread.uri.toString() !== uri) continue;
            this.editing.delete(id);
            if (!this.threads.has(id)) edit.thread.dispose();
        }
        for (const [id, thread] of this.threads) {
            if (thread.uri.toString() !== uri) continue;
            this.threads.delete(id);
            thread.dispose();
        }
    }

    renderThread(thread, note) {
        const conversation = [note, ...this.notes.filter(item => item.parentId === note.id)];
        const answer = this.answers.get(note.id);
        const input = thread.comments[0] ?? comment(note.question, '我的批注');
        input.body = new vscode.MarkdownString(note.question);
        input.mode = vscode.CommentMode.Preview;
        input.contextValue = undefined;
        const comments = [input];
        const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === thread.uri.toString());
        const digest = document && this.digest(document);
        for (const [index, item] of conversation.entries()) {
            if (index) {
                const followUp = comment(item.question, '我的追问');
                followUp.label = this.noteStatus(item);
                comments.push(followUp);
            }
            const reply = this.answers.get(item.id);
            if (!reply) continue;
            const response = comment(reply, 'Codex');
            response.noteId = item.id;
            if (this.references.get(item.id)?.length) response.contextValue = 'codeGuideReplyWithReferences';
            if (item.sourceDigest && digest && item.sourceDigest !== digest) response.label = '源码文件提交后有更新';
            comments.push(response);
        }
        thread.comments = comments;
        thread.canReply = Boolean(answer) && !note.resolved;
        thread.contextValue = note.resolved ? 'zzzReviewClosed'
            : answer ? 'zzzReviewAnswered' : note.batch ? 'zzzReviewSubmitted' : 'zzzReviewDraft';
        thread.state = note.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    }

    digest(document) {
        const cached = this.digests.get(document);
        if (cached?.version === document.version) return cached.value;
        const value = sourceDigest(document.getText());
        this.digests.set(document, { version: document.version, value });
        return value;
    }

    async open(reference) {
        const note = this.notes.find(current => current.id === reference.id);
        if (!note) return;
        let doc;
        try {
            doc = await vscode.workspace.openTextDocument(sourceUri(note));
        } catch (error) {
            if (error.code !== 'FileNotFound' && !/not found|does not exist/i.test(error.message)) throw error;
        }
        const location = doc && locateAnchor(documentLines(doc), note.anchor);
        if (!location) {
            const answer = this.answers.get(note.id);
            const text = [
                '原位置无法唯一定位。下面保留了创建批注时的代码。',
                note.path + ':' + note.anchor.line,
                '', note.anchor.code, '', '问题', note.question, '', 'Codex 回答', answer ?? '尚未回答'
            ].join('\n');
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: text }), { preview: true });
            return;
        }
        const range = rangeAt(doc, location);
        await vscode.window.showTextDocument(doc, { selection: range, preview: true });
        this.syncDocument(doc);
        const thread = this.threads.get(note.parentId ?? note.id);
        if (thread) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }

    async reply(value) {
        const root = this.threadNote(value?.thread);
        const question = value?.text?.trim();
        if (!root || root.resolved || !this.answers.has(root.id) || !question) return;
        await this.persist([...this.notes, {
            id: randomUUID(), root: root.root, path: root.path, anchor: root.anchor, parentId: root.id,
            question, createdAt: new Date().toISOString()
        }]);
        this.refreshView();
    }

    async openReference(id) {
        const note = this.notes.find(item => item.id === id);
        const refs = this.references.get(id);
        if (!note || !refs?.length) return;
        const choice = await vscode.window.showQuickPick(refs.map(ref => ({
            label: ref.label, description: ref.path + ':' + ref.line, ref
        })), { placeHolder: '跳到回答引用的代码或文档' });
        if (!choice) return;
        const uri = vscode.Uri.joinPath(vscode.Uri.file(note.root), ...choice.ref.path.split('/'));
        const document = await vscode.workspace.openTextDocument(uri);
        const line = Math.min(choice.ref.line, document.lineCount) - 1;
        await vscode.window.showTextDocument(document, { selection: document.lineAt(line).range, preview: true });
    }

    async draftTask(thread) {
        const root = this.threadNote(thread);
        if (!root) return;
        const choice = await vscode.window.showQuickPick([root, ...this.notes.filter(note => note.parentId === root.id)]
            .filter(note => this.answers.has(note.id)).map(note => ({ label: note.question, note })),
        { placeHolder: '选一条已回答的批注生成单独的修改请求' });
        if (!choice) return;
        const note = choice.note;
        const refs = this.references.get(note.id) ?? [];
        const content = [
            '/dev 请在确认以下代码批注的结论后，只修改与该问题直接相关的代码。',
            '', '位置 ' + note.path + ':' + note.anchor.line, '', '原始问题', note.question,
            '', 'Codex 回答', this.answers.get(note.id),
            ...(refs.length ? ['', '相关源码', ...refs.map(ref => '- ' + ref.path + ':' + ref.line + ' ' + ref.label)] : [])
        ].join('\n');
        const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
        this.taskDrafts.set(document.uri.toString(), note.root);
        await vscode.window.showTextDocument(document, { preview: false });
    }

    async sendTaskDraft() {
        requireTrust();
        const document = vscode.window.activeTextEditor?.document;
        const root = document && this.taskDrafts.get(document.uri.toString());
        if (!root) throw new Error('请打开由批注生成的修改请求草稿。');
        const target = this.targets[root];
        if (!target) throw new Error('请先绑定 Codex 对话。');
        const prompt = document.getText().trim();
        if (!prompt) return;
        const choice = await vscode.window.showWarningMessage(
            '把当前修改请求单独发送到「' + target.label + '」？', { modal: true }, '发送修改请求'
        );
        if (!choice) return;
        const executable = await executableFor(this.globalState.get(cliKey), root);
        const result = await deliver(executable, root, threadIdFor(target.id), prompt);
        if (result.state !== 'queued') {
            throw new Error('未确认修改请求已排队。请先打开目标对话核对。' +
                (result.diagnostic ? '\n' + result.diagnostic : ''));
        }
        this.taskDrafts.delete(document.uri.toString());
        const wake = result.needsWake ? await this.wake(target) : '';
        vscode.window.showInformationMessage('修改请求已排队。' + wake);
    }

    async submit(workspace, target) {
        requireTrust();
        const active = target instanceof vscode.Uri ? target : vscode.window.activeTextEditor?.document.uri;
        const selected = sourceLocation(active);
        const root = workspace ? selected?.root ?? await selectRoot() : selected?.root;
        if (!root) return;
        const inScope = note => note.root === root && (workspace || note.path === selected?.path);
        const unfinished = [...this.editing.values()].filter(edit => inScope(edit.note)).length;
        const drafts = this.notes.filter(note => !note.batch && inScope(note) && !this.editing.has(note.id));
        if (!drafts.length) {
            const message = unfinished ? '请先保存正在编辑的批注。' : '当前范围没有待提交草稿。';
            vscode.window.setStatusBarMessage(message, 4500);
            return;
        }

        const destination = this.targets[root] ?? await this.bind(root);
        if (!destination) return;
        const documents = new Map();
        for (const note of drafts) {
            const uri = sourceUri(note);
            if (documents.has(note.path)) continue;
            const doc = await vscode.workspace.openTextDocument(uri).catch(error => {
                if (error.code !== 'FileNotFound' && !/not found|does not exist/i.test(error.message)) throw error;
            });
            if (!doc) {
                documents.set(note.path, {});
                continue;
            }
            if (doc.isDirty) throw new Error('先保存 ' + note.path + '，这样 Codex 才能读取同一版源码。');
            documents.set(note.path, { lines: documentLines(doc), digest: this.digest(doc) });
        }
        const files = new Set(drafts.map(note => note.path));
        const batchId = randomUUID();
        const packet = {
            protocol, batchId, workspaceRoot: root, createdAt: new Date().toISOString(),
            scope: workspace ? 'workspace' : 'file',
            questions: drafts.map(({ id, path, question, anchor, parentId }) => {
                const { lines, digest } = documents.get(path);
                const current = lines && locateAnchor(lines, anchor);
                const history = parentId && this.notes
                    .filter(note => note.id === parentId || note.parentId === parentId)
                    .filter(note => this.answers.has(note.id))
                    .map(note => ({ question: note.question, answer: this.answers.get(note.id) }));
                return {
                    id, path, question, original: anchor,
                    sourceDigest: digest, history: history || undefined,
                    current: current ? { line: current.start + 1, endLine: current.end + 1 } : null
                };
            })
        };
        const requestPath = inbox + '/' + batchId + '/request.json';
        const folder = vscode.Uri.file(root);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder, inbox, batchId));
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, requestPath),
            Buffer.from(JSON.stringify(packet, null, 2) + '\n', 'utf8'));
        const ids = new Set(drafts.map(note => note.id));
        await this.recordDelivery(batchId, { target: destination, state: 'failed', diagnostic: '批次已保存，尚未投递。' });
        await this.persist(this.notes.map(note => ids.has(note.id)
            ? { ...note, batch: batchId, sourceDigest: documents.get(note.path).digest } : note));
        this.refreshView();
        await this.send({ id: batchId, root }, destination, drafts.length + ' 条批注，' + files.size + ' 个文件'
            + (unfinished ? '。另有 ' + unfinished + ' 条仍在编辑' : ''));
    }

    async bind(root = activeRoot()) {
        root = root ?? await selectRoot();
        if (!root) return;
        const current = this.targets[root];
        const link = await vscode.window.showInputBox({
            title: '绑定 Codex 桌面对话', prompt: '从 Codex 复制同一工作区的对话链接，或粘贴对话 UUID。',
            value: current ? 'codex://threads/' + current.id : '',
            ignoreFocusOut: true,
            validateInput: value => {
                try { threadIdFor(value); } catch (error) { return error.message; }
            }
        });
        if (!link) return;
        const id = threadIdFor(link);
        const label = await vscode.window.showInputBox({
            title: '此对话在 VS Code 中的名称',
            value: current?.label ?? '代码走读',
            validateInput: value => value.trim() ? undefined : '请输入显示名称。'
        });
        if (!label?.trim()) return;
        const target = { id, label: label.trim() };
        const updated = { ...this.targets, [root]: target };
        await this.storage.update(targetKey, updated);
        this.targets = updated;
        this.events.fire();
        return target;
    }

    async openTarget() {
        const root = activeRoot() ?? await selectRoot();
        const target = this.targets[root];
        if (!target) throw new Error('请先绑定 Codex 对话。');
        await openCodexThread(target);
    }

    async setCli() {
        requireTrust();
        const choice = await vscode.window.showOpenDialog({
            title: '选择 Codex 可执行文件', canSelectMany: false,
            ...(process.platform === 'win32' ? { filters: { 'Codex CLI': ['exe'] } } : {})
        });
        if (!choice?.[0]) return;
        const file = choice[0].fsPath;
        if (!/^codex(?:\.exe)?$/i.test(file.split(/[\\/]/).at(-1))) {
            throw new Error('请选择 codex 或 codex.exe。');
        }
        await executableFor(file, activeRoot() ?? await selectRoot());
        await this.globalState.update(cliKey, file);
    }

    async recordDelivery(id, entry) {
        const updated = { ...this.deliveries, [id]: entry };
        await this.storage.update(deliveryKey, updated);
        this.deliveries = updated;
        this.events.fire();
    }

    async send(batch, target, caption = '批次 ' + batch.id.slice(0, 8)) {
        let executable;
        const prompt = promptFor(batch.root, batch.id);
        try {
            executable = await executableFor(this.globalState.get(cliKey), batch.root);
        } catch (error) {
            await this.recordDelivery(batch.id, { target, state: 'failed', diagnostic: error.message });
            const choice = await vscode.window.showWarningMessage(error.message, '复制本批次指令');
            if (choice) await vscode.env.clipboard.writeText(prompt);
            return;
        }
        await this.recordDelivery(batch.id, { target, state: 'unknown', diagnostic: '等待 Codex 投递回执。' });
        const result = await deliver(executable, batch.root, threadIdFor(target.id), prompt);
        await this.recordDelivery(batch.id, { target, ...result });
        if (result.state === 'queued') {
            const wake = result.needsWake ? await this.wake(target) : '';
            vscode.window.showInformationMessage(caption + '，已进入「' + target.label + '」的队列。'
                + wake);
        } else {
            vscode.window.showWarningMessage(result.state === 'unknown'
                ? '投递状态不明，批次已保留。请先查看目标对话。'
                : 'Codex 拒绝投递，已保留批次。请查看批次详情后重试。');
        }
    }

    async wake(target) {
        // CLI 已经入队。打开原对话只负责加载会话，不能重投同一条消息。
        if (await openCodexThread(target).catch(() => false)) return '已请求桌面端打开目标对话继续处理。';
        return '请在桌面端打开目标对话继续处理。';
    }

    async retry() {
        requireTrust();
        await this.refreshAnswers();
        const batch = await this.pickBatch(candidate => !this.processing.has(candidate.id) &&
            ['failed', 'unknown'].includes(this.deliveries[candidate.id]?.state));
        if (!batch) return;
        const entry = this.deliveries[batch.id];
        if (entry.state === 'unknown') {
            const confirmed = await vscode.window.showWarningMessage(
                '此批次可能已经进队列。请核对目标对话后再重试。', { modal: true }, '重试');
            if (!confirmed) return;
        }
        const bound = this.targets[batch.root];
        const target = entry.state === 'failed' && bound ? bound : entry.target;
        await this.send(batch, target);
    }

    batches() {
        const groups = new Map();
        for (const note of this.workspaceNotes()) {
            if (!note.batch) continue;
            if (!groups.has(note.batch)) groups.set(note.batch, { id: note.batch, root: note.root, ids: [], paths: new Set() });
            const batch = groups.get(note.batch);
            batch.ids.push(note.id);
            batch.paths.add(note.path);
        }
        return [...groups.values()];
    }

    async pickBatch(filter = () => true) {
        const choices = this.batches().filter(batch => batch.ids.some(id => !this.answers.has(id)) && filter(batch)).map(batch => ({
            label: [...batch.paths].map(path => path.split('/').at(-1)).join('、'),
            description: batch.ids.length + ' 条 · ' + batch.id.slice(0, 8),
            batch
        }));
        if (!choices.length) throw new Error('没有符合条件的待回答批次。');
        const choice = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, { placeHolder: '选择批次' });
        return choice?.batch;
    }

    async copy() {
        const batch = await this.pickBatch();
        if (!batch) return;
        await vscode.env.clipboard.writeText(promptFor(batch.root, batch.id));
        vscode.window.setStatusBarMessage('已复制 Codex 投递指令。', 4500);
    }

    async refreshAnswers() {
        const answers = new Map();
        const refs = new Map();
        const processing = new Set();
        const errors = new Map();
        for (const batch of this.batches()) {
            const directory = vscode.Uri.joinPath(vscode.Uri.file(batch.root), inbox, batch.id);
            try {
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(directory, 'answers.json'));
                const packet = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
                const batchRefs = new Map();
                for (const [id, answer] of validateAnswers(packet, batch, batchRefs)) answers.set(id, answer);
                for (const [id, references] of batchRefs) refs.set(id, references);
                continue;
            } catch (error) {
                if (error.code !== 'FileNotFound') errors.set(batch.id, batch.id + ' · ' + error.message);
            }
            try {
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(directory, 'status.json'));
                const status = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
                if (status.protocol === protocol && status.batchId === batch.id && status.state === 'processing') processing.add(batch.id);
            } catch (error) {
                if (error.code !== 'FileNotFound' && !errors.has(batch.id)) errors.set(batch.id, batch.id + ' · ' + error.message);
            }
        }
        this.answers = answers;
        this.references = refs;
        this.processing = processing;
        this.errors = errors;
        this.refreshView();
    }

    refreshView() {
        for (const doc of vscode.workspace.textDocuments) this.syncDocument(doc);
        this.events.fire();
    }
}

function editingComment(input, noteId) {
    input.noteId = noteId;
    input.mode = vscode.CommentMode.Editing;
    input.contextValue = 'zzzReviewEditor';
    return input;
}

function comment(text, name) {
    return { body: new vscode.MarkdownString(text), author: { name }, mode: vscode.CommentMode.Preview };
}

function treeRow(label, icon, children, expanded) {
    const state = children
        ? expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    const tree = new vscode.TreeItem(label, state);
    tree.iconPath = new vscode.ThemeIcon(icon);
    return { tree, children };
}

function localFolders() {
    return (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
}

function activeRoot() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const folder = uri?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri);
    const folders = localFolders();
    return folder?.uri.fsPath ?? (folders.length === 1 ? folders[0].uri.fsPath : undefined);
}

async function selectRoot() {
    const folders = localFolders();
    if (!folders.length) throw new Error('请先打开本地工作区。');
    if (folders.length === 1) return folders[0].uri.fsPath;
    const choice = await vscode.window.showQuickPick(folders.map(folder => ({
        label: folder.name, description: folder.uri.fsPath
    })), { placeHolder: '选择工作区根目录' });
    return choice?.description;
}

function requireTrust() {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区，再投递代码批注。');
}

function openCodexThread(target) {
    return vscode.env.openExternal(vscode.Uri.parse('codex://threads/' + threadIdFor(target.id)));
}

function sourceLocation(uri) {
    if (!uri || uri.scheme !== 'file') return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return undefined;
    const path = relativeSource(folder.uri.fsPath, uri.fsPath);
    return safeSourcePath(path) ? { root: folder.uri.fsPath, path } : undefined;
}

function sourceUri(note) {
    if (!safeSourcePath(note.path)) throw new Error('批注的代码路径无效。');
    return vscode.Uri.joinPath(vscode.Uri.file(note.root), ...note.path.split('/'));
}

function documentLines(doc) {
    return doc.getText().split(/\r?\n/);
}

function rangeAt(doc, location) {
    return new vscode.Range(doc.lineAt(location.start).range.start, doc.lineAt(location.end).range.end);
}

module.exports = { activateReview };
