// Release to the existing web-app deployment, so the /exec URL (and every iPhone Shortcut) stays the same.
//   npm run release -- "short message"
// Steps: tests -> clasp push -> save a version named "vX.Y.Z: message" -> redeploy that version to the one real deployment
// -> wait until the URL answers. Refuses to continue if the tests fail or if it cannot tell which deployment is the live one.
// A real (non --test) release then commits everything and pushes to GitHub origin/main.
// Version number comes from package.json; bump it and add the CHANGELOG entry first.
//   npm run release -- --test "short message"   same steps against the throwaway test project in private/clasp_test (git-ignored;
//   its own sheet copy, script, token and /exec URL). The first run creates the test deployment. The real project is never touched.
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2), test = args.includes('--test');
const message = args.filter(a => a !== '--test').join(' ').trim();
const version = require('../package.json').version;
if (!message) { console.error('Usage: npm run release -- [--test] "short message"'); process.exit(1); }
const project = test ? ['-P', 'private/clasp_test'] : [];
if (test && !require('fs').existsSync(path.join(root, 'private', 'clasp_test', '.clasp.json'))) {
  console.error('No test project. Create it first: npx clasp create-script --type standalone --title inventory-test -P private/clasp_test'); process.exit(1);
}

function run(cmd, args, capture) {
  const r = spawnSync(cmd, args, { cwd: root, shell: true, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  if (r.status !== 0) { console.error(`\n${cmd} ${args.join(' ')} failed`); process.exit(1); }
  return r.stdout || '';
}
const clasp = (args, capture) => run('npx', ['clasp'].concat(project, args), capture);

// Guard: toGithub() does `git add -A`, so refuse to release if a private-looking file would be committed.
const unsafe = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).stdout.split('\n')
  .filter(f => /^private\//.test(f) || (/\.(xlsx|csv|jpe?g|png|pdf)$/i.test(f) && !f.startsWith('tests/fixtures/')) || (/(^|\/)\.env$|keys\.json$/.test(f) && !/example/.test(f)));
if (unsafe.length) { console.error('Refusing to release: private-looking files would be committed:\n  ' + unsafe.join('\n  ')); process.exit(1); }

run('npm', ['test']);
clasp(['push', '-f']);
const made = clasp(['create-version', JSON.stringify(`${test ? 'TEST ' : ''}v${version}: ${message}`)], true);
const n = (/version\s+(\d+)/i.exec(made) || [])[1];
if (!n) { console.error('could not read the new version number from: ' + made); process.exit(1); }

const live = clasp(['list-deployments'], true).split('\n').map(l => /^-\s+(\S+)\s+@(\S+)/.exec(l)).filter(m => m && m[2] !== 'HEAD');
if (live.length > 1 || (!test && live.length !== 1)) { console.error(`expected exactly one deployment besides @HEAD, found ${live.length}; deploy by hand with: npx clasp deploy -i <id> -V ${n}`); process.exit(1); }
let id;
if (live.length) { id = live[0][1]; clasp(['deploy', '-i', id, '-V', n]); }
else {   // first test release: create the one test deployment, then read its id back
  clasp(['deploy', '-V', n]);
  const made2 = clasp(['list-deployments'], true).split('\n').map(l => /^-\s+(\S+)\s+@(\S+)/.exec(l)).filter(m => m && m[2] !== 'HEAD');
  if (made2.length !== 1) { console.error('deployed, but could not read the new deployment id; run: npx clasp -P private/clasp_test list-deployments'); process.exit(1); }
  id = made2[0][1];
}

function toGithub() {   // official releases are also committed and pushed; a failed push only warns (the deployment is already live)
  const git = a => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  git(['add', '-A']);
  if (git(['status', '--porcelain']).stdout.trim()) git(['commit', '-m', `v${version}: ${message}`]);
  const p = git(['push', '-u', 'origin', 'main']);
  console.log(p.status === 0 ? 'pushed to GitHub' : 'WARNING: git push failed, push by hand: ' + (p.stderr || '').trim().split('\n').pop());
}

(async () => {
  const url = `https://script.google.com/macros/s/${id}/exec`;
  for (let i = 0; i < 8; i++) {   // a fresh deployment answers with Google's "unable to open the file" page for up to a minute
    try { const body = await (await fetch(url)).text(); if (body.includes('"ok":true')) { console.log(`\nv${version} is live as Apps Script version ${n} on ${id}`); if (!test) toGithub(); return; } } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 10000));
  }
  console.error('deployed, but the URL has not answered yet; open it in a browser to check');
  process.exit(1);
})();
