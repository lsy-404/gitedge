import { GitTransferTimeouts } from "../../../packages/contracts/src/github-sync";

export const GIT_TRANSFER_PROGRAM = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => text += chunk);
process.stdin.on('end', async () => {
  let diagnostic = 'Native Git command failed.';
  try {
    const { operation, plan } = JSON.parse(text);
    const root = process.cwd();
    const directory = path.join(root, 'repository.git');
    const hooks = path.join(root, 'hooks');
    const settings = {
      'credential.helper': '',
      'http.followRedirects': 'false',
      'protocol.allow': 'never',
      'protocol.https.allow': 'always',
      'protocol.http.allow': 'always',
      'pack.threads': '1',
      'pack.windowMemory': '16m',
      'core.packedGitLimit': '32m',
      'core.packedGitWindowSize': '8m',
      ['http.' + plan.source.url + '.extraHeader']: 'Authorization: ' + plan.source.authorization,
      ['http.' + plan.destination.url + '.extraHeader']: 'Authorization: ' + plan.destination.authorization,
    };
    const env = { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', GIT_CONFIG_COUNT: String(Object.keys(settings).length) };
    Object.entries(settings).forEach(([key, value], index) => { env['GIT_CONFIG_KEY_' + index] = key; env['GIT_CONFIG_VALUE_' + index] = value; });
    const deadline = Date.now() + (operation === 'prepare' ? ${GitTransferTimeouts.prepare} : ${GitTransferTimeouts.push});
    const git = args => spawnSync('git', args, { env, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: Math.max(1, deadline - Date.now()) });
    const failure = result => {
      let message = operation + ': ' + (result.error?.code ?? result.status) + ': ' + (result.stderr || 'Git command failed.');
      const secrets = [];
      for (const remote of [plan.source, plan.destination]) {
        const value = remote.authorization.split(' ')[1];
        secrets.push(remote.authorization, value);
        if (remote.authorization.startsWith('Basic ')) secrets.push(Buffer.from(value, 'base64').toString().split(':').slice(1).join(':'));
      }
      for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) message = message.replaceAll(secret, '[REDACTED]');
      return Buffer.from(message).subarray(0, 768).toString('utf8');
    };
    const checked = args => { const result = git(args); if (result.status !== 0) { diagnostic = failure(result); throw Error('git_failed'); } return result.stdout.trim(); };
    const result = status => process.stdout.write(JSON.stringify({ status, ...(status === 'failed' ? { diagnostic } : {}) }));
    if (operation === 'prepare') {
      checked(['init', '--bare', directory]);
      if (plan.after !== '0'.repeat(40)) {
        for (let attempt = 0; ; attempt++) {
          const fetched = git(['--git-dir=' + directory, 'fetch', '--no-tags', plan.source.url, plan.ref]);
          if (fetched.status === 0) break;
          diagnostic = failure(fetched);
          const transient = fetched.error?.code === 'ETIMEDOUT' || /early EOF|unexpected disconnect|bytes (?:of body are still expected|remaining to read)|Could not resolve host|Failed to connect|Connection reset|timed out|Recv failure|Empty reply from server|HTTP (?:500|502|503|504)/i.test(fetched.stderr || '');
          const delay = 1000 * (attempt + 1);
          if (!transient || attempt === 2 || Date.now() + delay >= deadline) throw Error('git_failed');
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        const fetched = checked(['--git-dir=' + directory, 'rev-parse', 'FETCH_HEAD']);
        if (fetched !== plan.after) return result('stale');
        checked(['--git-dir=' + directory, 'update-ref', 'refs/transfer/source', plan.after]);
      }
      return result('ready');
    }
    if (operation !== 'push') throw Error('invalid_operation');
    fs.mkdirSync(hooks, { recursive: true, mode: 0o700 });
    const guard = '#!/usr/bin/env node\n' +
      "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const rows=input.trim().split('\\n');const valid=rows.length===1&&rows[0].split(' ')[2]===process.env.SYNC_TARGET_REF&&rows[0].split(' ')[3]===process.env.SYNC_BEFORE;if(!valid)process.stderr.write('sync_destination_changed\\n');process.exit(valid?0:1);});\n";
    fs.writeFileSync(path.join(hooks, 'pre-push'), guard, { mode: 0o700 });
    env.SYNC_BEFORE = plan.before;
    env.SYNC_TARGET_REF = plan.targetRef;
    const args = ['--git-dir=' + directory, '-c', 'core.hooksPath=' + hooks, 'push', '--porcelain', plan.destination.url,
      (plan.after === '0'.repeat(40) ? '' : 'refs/transfer/source') + ':' + plan.targetRef];
    const pushed = git(args);
    if (pushed.status === 0) return result('synced');
    if (/\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|sync_destination_changed/.test(pushed.stdout + pushed.stderr)) return result('conflict');
    diagnostic = failure(pushed);
    return result('failed');
  } catch {
    process.stdout.write(JSON.stringify({ status: 'failed', diagnostic }));
  }
});
`;
