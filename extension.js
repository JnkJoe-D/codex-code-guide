const vscode = require('vscode');
const { activateReview } = require('./review');
const { activateDistribution } = require('./distribution');

const viewId = 'zzzCodeGuide.context';
const catalogPaths = ['.code-guide/navigation.json', 'docs/代码导读/VSCode导航索引.json'];
const openCommand = 'zzzCodeGuide.openLink';
const catalogFile = uri => catalogPaths.some(path => uri.path.endsWith('/' + path));

function activate(context) {
    activateReview(context);
    activateDistribution(context);
    const provider = new GuideTree(vscode.window.activeTextEditor);
    const view = vscode.window.createTreeView(viewId, { treeDataProvider: provider });
    context.subscriptions.push(
        provider,
        view,
        vscode.window.onDidChangeActiveTextEditor(editor => provider.follow(editor)),
        vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
        vscode.workspace.onDidSaveTextDocument(document => {
            if (catalogFile(document.uri)) provider.refresh();
        }),
        vscode.commands.registerCommand('zzzCodeGuide.refresh', () => provider.refresh()),
        vscode.commands.registerCommand(openCommand, async (folder, link) => {
            try {
                const uri = resolveLink(folder, link.path);
                const document = await vscode.workspace.openTextDocument(uri);
                const line = findAnchor(document, link.anchor);
                const selection = line === undefined ? undefined : new vscode.Range(line, 0, line, 0);
                await vscode.window.showTextDocument(document, { preview: true, selection });
                if (link.anchor && line === undefined) {
                    vscode.window.setStatusBarMessage('导读锚点已变更，已打开原文件。', 5000);
                }
            } catch (error) {
                vscode.window.showWarningMessage('无法打开导读目标：' + error.message);
            }
        })
    );
}

class GuideTree {
    constructor(editor) {
        this.changed = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.changed.event;
        this.catalogs = new Map();
        this.source = sourceUri(editor);
    }

    follow(editor) {
        const uri = sourceUri(editor);
        // 打开说明章节时，侧栏保留上次阅读的 C# 文件。
        if (uri && uri.toString() !== this.source?.toString()) {
            this.source = uri;
            this.changed.fire();
        }
    }

    refresh() {
        this.catalogs.clear();
        this.changed.fire();
    }

    dispose() {
        this.changed.dispose();
    }

    getTreeItem(item) {
        return item.tree;
    }

    async getChildren(item) {
        if (typeof item?.directory === 'string') {
            return this.siblingFiles(item.folder, item.directory, item.current);
        }
        if (item) return item.children ?? [];

        const current = this.source;
        try {
            const project = await this.findProject(current);
            if (!project) {
                return [node('可在 .code-guide/navigation.json 配置本项目的导读索引。', 'info')];
            }

            const { folder, topics } = project;
            const relative = relativeFile(folder, current);
            const context = relative && matchTopic(topics, relative);
            const root = [];
            if (relative) {
                const file = node(relative.split('/').at(-1), 'symbol-file');
                file.tree.description = relative.split('/').slice(0, -1).join('/');
                file.tree.tooltip = relative;
                root.push(file);
            }
            const selected = context ?? topics[0];
            root.push(topicNode(folder, selected, relative, true));
            if (relative) {
                const siblings = node('同目录文件', 'folder', [], false);
                siblings.folder = folder;
                siblings.directory = relative.substring(0, relative.lastIndexOf('/'));
                siblings.current = relative;
                root.push(siblings);
            }
            root.push(node('全部主题', 'list-tree', topics.map(topic => topicNode(folder, topic, relative, false)), false));
            return root;
        } catch (error) {
            return [node('无法读取导读索引：' + error.message, 'warning')];
        }
    }

    async findProject(current) {
        const preferred = current && vscode.workspace.getWorkspaceFolder(current);
        const folders = vscode.workspace.workspaceFolders ?? [];
        const candidates = preferred ? [preferred, ...folders.filter(folder => folder !== preferred)] : folders;
        for (const folder of candidates) {
            const key = folder.uri.toString();
            if (!this.catalogs.has(key)) {
                this.catalogs.set(key, readCatalog(folder.uri));
            }
            const topics = await this.catalogs.get(key);
            if (topics) return { folder: folder.uri, topics };
        }
        return undefined;
    }

    async siblingFiles(folder, directory, current) {
        try {
            const uri = directory ? resolveLink(folder, directory) : folder;
            const entries = await vscode.workspace.fs.readDirectory(uri);
            return entries
                .filter(([, type]) => type & vscode.FileType.File)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([name]) => linkNode(folder, { label: name, path: directory ? directory + '/' + name : name }, current));
        } catch (error) {
            return [node('无法读取目录：' + error.message, 'warning')];
        }
    }
}

async function readCatalog(folder) {
    for (const path of catalogPaths) {
        let bytes;
        try {
            bytes = await vscode.workspace.fs.readFile(resolveLink(folder, path));
        } catch (error) {
            if (error.code === 'FileNotFound') continue;
            throw error;
        }
        const { topics } = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!Array.isArray(topics) || topics.length === 0) {
            throw new Error('索引必须至少包含一个主题。');
        }
        return topics;
    }
}

function sourceUri(editor) {
    const uri = editor?.document.uri;
    return uri?.scheme === 'file' && !catalogFile(uri) &&
        editor.document.languageId !== 'markdown' && vscode.workspace.getWorkspaceFolder(uri)
        ? uri
        : undefined;
}

function relativeFile(folder, uri) {
    const prefix = folder.path.endsWith('/') ? folder.path : folder.path + '/';
    if (uri?.path.toLowerCase().startsWith(prefix.toLowerCase())) {
        return uri.path.slice(prefix.length);
    }
    return undefined;
}

function matchTopic(topics, relative) {
    let selected;
    let longest = 0;
    const file = relative.toLowerCase();
    for (const topic of topics) {
        for (const path of topic.match) {
            const prefix = path.toLowerCase();
            const matches = prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix;
            if (matches && prefix.length > longest) {
                selected = topic;
                longest = prefix.length;
            }
        }
    }
    return selected;
}

function topicNode(folder, topic, current, expanded) {
    const steps = topic.read.map((link, index) => linkNode(folder, link, current, index + 1));
    const docs = topic.docs.map(link => linkNode(folder, link, current));
    const intent = node('设计意图', 'lightbulb');
    intent.tree.description = topic.intent;
    intent.tree.tooltip = topic.intent;
    return node(topic.title, 'book', [
        intent,
        node('按顺序读代码', 'list-ordered', steps, expanded),
        node('设计文档与审查线索', 'references', docs, expanded)
    ], expanded);
}

function linkNode(folder, link, current, step) {
    const label = step === undefined ? link.label : step + '. ' + link.label;
    const icon = /\.md$/i.test(link.path) ? 'book' : 'go-to-file';
    const item = node(label, icon);
    item.tree.tooltip = link.anchor ? link.path + '\n' + link.anchor : link.path;
    if (current?.toLowerCase() === link.path.toLowerCase()) item.tree.description = '当前文件';
    item.tree.command = { command: openCommand, title: '打开导航目标', arguments: [folder, link] };
    return item;
}

function node(label, icon, children, expanded) {
    const state = children
        ? expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    const tree = new vscode.TreeItem(label, state);
    tree.iconPath = new vscode.ThemeIcon(icon);
    return { tree, children };
}

function resolveLink(folder, relative) {
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[:\\\\]/.test(part))) {
        throw new Error('导航目标必须使用工作区内的相对路径。');
    }
    return vscode.Uri.joinPath(folder, ...parts);
}

function findAnchor(document, anchor) {
    if (!anchor) return undefined;
    const markdown = /\.md$/i.test(document.uri.path);
    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i).text.trimStart();
        const matches = markdown ? line.match(/^#{1,6}\s+(.*)$/)?.[1].trim() === anchor : line.startsWith(anchor);
        if (matches) return i;
    }
    return undefined;
}

module.exports = { activate };
