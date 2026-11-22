const vscode = require('vscode');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { homedir, tmpdir } = require('node:os');
const path = require('node:path');
const manifest = require('./package.json');

const repository = 'JnkJoe-D/codex-code-guide';
const updateKey = 'codeGuide.githubUpdates';
const checkedKey = 'codeGuide.lastGithubCheck';
const intervalMs = 24 * 60 * 60 * 1000;
const skillName = 'code-guide-review';

function activateDistribution(context) {
    const run = action => async () => {
        try { await action(); }
        catch (error) { vscode.window.showWarningMessage('代码导读：' + error.message); }
    };
    context.subscriptions.push(
        vscode.commands.registerCommand('zzzCodeGuide.installSkill', run(() => installSkill(context))),
        vscode.commands.registerCommand('zzzCodeGuide.checkUpdate', run(() => checkForUpdates(context, true))),
        vscode.commands.registerCommand('zzzCodeGuide.setUpdates', run(async () => {
            const choice = await vscode.window.showQuickPick([
                { label: '自动安装 GitHub 正式版', value: 'auto' },
                { label: '有新版时提醒我', value: 'notify' },
                { label: '关闭自动检查', value: 'off' }
            ], { placeHolder: '选择此 VS Code 用户的更新方式' });
            if (!choice) return;
            await context.globalState.update(updateKey, choice.value);
            if (choice.value !== 'off') await checkForUpdates(context, false, true);
        }))
    );
    checkForUpdates(context, false).catch(error => console.warn('[Code Guide update]', error.message));
}

async function installSkill(context) {
    const home = homedir();
    const folder = path.join(home, '.agents', 'skills', skillName);
    const target = path.join(folder, 'SKILL.md');
    const source = context.asAbsolutePath(path.join('skills', skillName, 'SKILL.md'));
    const skill = await fs.readFile(source);
    const previous = await fs.readFile(target).catch(error => {
        if (error.code !== 'ENOENT') throw error;
    });
    if (previous?.equals(skill)) {
        vscode.window.showInformationMessage('Codex 批注 Skill 已是此扩展附带的版本。');
        return;
    }
    const label = previous ? '替换 Skill' : '安装 Skill';
    const confirm = await vscode.window.showInformationMessage(
        label + '到 ' + folder + '？', { modal: true }, label
    );
    if (!confirm) return;
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(target, skill, { flag: previous ? 'w' : 'wx' });
    vscode.window.showInformationMessage('Codex 批注 Skill 已安装。若当前会话未发现它，重启 Codex 即可。');
}

function stableVersion(version) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
    return match?.slice(1).map(Number);
}

function newerThan(candidate, installed) {
    const left = stableVersion(candidate);
    const right = stableVersion(installed);
    if (!left || !right) return false;
    const firstDifference = left.findIndex((part, i) => part !== right[i]);
    return firstDifference !== -1 && left[firstDifference] > right[firstDifference];
}

let checking = false;
async function checkForUpdates(context, manual, force = false) {
    const mode = context.globalState.get(updateKey, 'notify');
    const checked = context.globalState.get(checkedKey, 0);
    if (checking || (!manual && !force && (mode === 'off' || Date.now() - checked < intervalMs))) return;
    checking = true;
    try {
        await context.globalState.update(checkedKey, Date.now());
        const response = await fetch('https://api.github.com/repos/' + repository + '/releases/latest', {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': manifest.name },
            signal: AbortSignal.timeout(12000)
        });
        if (!response.ok) throw new Error('GitHub 版本检查失败，HTTP ' + response.status + '。');
        const release = await response.json();
        if (release.draft || release.prerelease || !newerThan(release.tag_name, manifest.version)) {
            if (manual) vscode.window.showInformationMessage('已安装最新 GitHub 正式版 v' + manifest.version + '。');
            return;
        }
        const tag = release.tag_name;
        const name = manifest.name + '-' + tag.replace(/^v/, '') + '.vsix';
        const url = 'https://github.com/' + repository + '/releases/download/' + tag + '/' + name;
        const asset = release.assets?.find(item => item.name === name && item.browser_download_url === url);
        const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset?.digest ?? '')?.[1];
        if (!asset || !digest || asset.size <= 0 || asset.size > 16 * 1024 * 1024) {
            throw new Error('GitHub 正式版缺少有效的 VSIX 或校验信息。');
        }
        if (mode !== 'auto' || manual) {
            const action = await vscode.window.showInformationMessage('代码导读 ' + tag + ' 可更新。', '安装更新', '查看发布说明');
            if (action === '查看发布说明') {
                await vscode.env.openExternal(vscode.Uri.parse('https://github.com/' + repository + '/releases/tag/' + tag));
            }
            if (action !== '安装更新') return;
        }

        const download = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!download.ok) throw new Error('VSIX 下载失败，HTTP ' + download.status + '。');
        const bytes = Buffer.from(await download.arrayBuffer());
        if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== digest.toLowerCase()) {
            throw new Error('VSIX 的大小或 SHA-256 校验失败。');
        }
        const directory = await fs.mkdtemp(path.join(tmpdir(), 'code-guide-'));
        try {
            const file = path.join(directory, name);
            await fs.writeFile(file, bytes);
            await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
        const reload = await vscode.window.showInformationMessage('代码导读 ' + tag + ' 已安装，重新加载窗口后启用。', '重新加载');
        if (reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } finally {
        checking = false;
    }
}

module.exports = { activateDistribution, newerThan };
