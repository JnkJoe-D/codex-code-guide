const fs = require('node:fs/promises');
const path = require('node:path');
const { homedir } = require('node:os');
const { execFile } = require('node:child_process');

function invoke(executable, args, cwd, timeout) {
    return new Promise(resolve => {
        execFile(executable, args, { cwd, timeout, windowsHide: true, maxBuffer: 65536 },
            (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
}

async function executableFor(preferred, root) {
    const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const onPath = (process.env.PATH ?? '').split(path.delimiter)
        .filter(directory => path.isAbsolute(directory))
        .map(directory => path.join(directory, name));
    const candidates = preferred ? [preferred] : [...onPath, ...await desktopBinaries(name)];
    for (const executable of candidates) {
        const probe = await invoke(executable, ['queue', '--help'], root, 5000);
        if (!probe.error && probe.stdout.includes('--thread') && probe.stdout.includes('--resume')) return executable;
    }
    throw new Error('找不到支持 codex queue 的 CLI。请更新 Codex，或运行「设置 Codex 命令位置」。');
}

async function desktopBinaries(name) {
    const home = homedir();
    if (process.platform === 'darwin') {
        return ['/Applications/Codex.app/Contents/Resources/codex', path.join(home, 'Applications/Codex.app/Contents/Resources/codex')];
    }
    if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return [];
    const root = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
        const directories = await fs.readdir(root, { withFileTypes: true });
        const candidates = await Promise.all(directories.filter(entry => entry.isDirectory()).map(async entry => {
            const file = path.join(root, entry.name, name);
            const stat = await fs.stat(file).catch(() => undefined);
            return { file, mtime: stat?.mtimeMs ?? 0 };
        }));
        return candidates.filter(entry => entry.mtime).sort((a, b) => b.mtime - a.mtime).map(entry => entry.file);
    } catch {
        return [];
    }
}

async function deliver(executable, root, thread, prompt) {
    const { error, stdout, stderr } = await invoke(executable,
        ['queue', '--cd', root, '--thread', thread, '--resume', '--message', prompt], root, 20000);
    const diagnostic = (stderr || stdout || error?.message || '').trim().slice(0, 600);
    if (!error) return { state: 'queued', diagnostic, needsWake: /message was queued, but could not resume thread/i.test(diagnostic) };
    const rejected = ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ||
        /(?:thread|session)[^\r\n]{0,120}(?:not found|does not exist|invalid)|(?:no|unknown) (?:matching )?(?:thread|session)/i.test(diagnostic);
    return { state: rejected ? 'failed' : 'unknown', diagnostic };
}

module.exports = { executableFor, deliver };
