"""把本地 git 提交链逐个按**原始元数据**推到 GitHub（Git Database API）。

★ 目的
  让 fork 的分支历史与本地**完全一致**（同 tree、同 parent、同 author/committer
  时间戳、同 message）→ 两边 SHA 相同，后续可继续用本工具增量推送。

  为什么不用 `git push`：本机到 github.com 的 TCP 443 不通
  （api.github.com / codeload.github.com / ssh.github.com:443 均正常）。

用法
  python gitpush_api.py push-chain <owner>/<repo> <branch> <local_sha> [msg_file]
"""
import io, json, os, re, subprocess, sys, time, urllib.request, urllib.error

API = 'https://api.github.com'
REPO = ''


def token():
    out = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n',
                         capture_output=True, text=True, encoding='utf-8', errors='replace').stdout
    for line in out.splitlines():
        if line.startswith('password='):
            return line.split('=', 1)[1].strip()
    raise SystemExit('未找到 GitHub 凭据')


TOK = token()


def api(method, path, payload=None, retries=3, timeout=90):
    global TOK
    url = path if path.startswith('http') else API + path
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    for i in range(retries):
        req = urllib.request.Request(url, data=data, method=method, headers={
            'Authorization': 'Bearer ' + TOK,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'gitpush-api',
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read().decode('utf-8', 'replace')
                return json.loads(body) if body.strip() else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf-8', 'replace')[:400]
            if e.code == 401 and i < retries - 1:
                # GCM 的 OAuth token 会被刷新，脚本持有的可能是旧值 → 重新取
                try:
                    TOK = token()
                except Exception:
                    pass
                time.sleep(1 + i); continue
            if e.code in (502, 503, 504) and i < retries - 1:
                time.sleep(2 * (i + 1)); continue
            raise SystemExit(f'API {method} {path} → HTTP {e.code}: {detail}')
        except Exception as e:
            if i < retries - 1:
                time.sleep(3 * (i + 1)); continue
            raise SystemExit(f'API {method} {path} 失败: {e}')


def git(*args):
    r = subprocess.run(['git'] + list(args), capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    return r.stdout.strip(), r.stderr.strip(), r.returncode


def raw_commit(sha):
    out, _, _ = git('cat-file', '-p', sha)
    head, _, msg = out.partition('\n\n')
    tree = re.search(r'^tree (\S+)', head, re.M).group(1)
    pm = re.search(r'^parent (\S+)', head, re.M)
    parent = pm.group(1) if pm else None
    def who(tag):
        m = re.search(rf'^{tag} (.*) <(.*)> (\d+) ([+-]\d{{4}})', head, re.M)
        name, email, ts, tz = m.group(1), m.group(2), int(m.group(3)), m.group(4)
        from datetime import datetime, timezone
        # 用固定偏移构造 ISO，保留原时区
        sign = 1 if tz[0] == '+' else -1
        off = sign * (int(tz[1:3]) * 60 + int(tz[3:5]))
        dt = datetime.fromtimestamp(ts, timezone.utc).astimezone(
            timezone(__import__('datetime').timedelta(minutes=off)))
        iso = dt.strftime('%Y-%m-%dT%H:%M:%S') + tz[:3] + ':' + tz[3:]
        return {'name': name, 'email': email, 'date': iso}
    msg = msg.rstrip(chr(10))   # GitHub 会自行补尾部换行；多送一个会导致 SHA 不一致
    return {'tree': tree, 'parent': parent, 'message': msg,
            'author': who('author'), 'committer': who('committer')}


def push_chain(repo, branch, local_sha):
    global REPO
    REPO = repo
    # 从 base 到 local_sha 的提交链（正序）
    chain, cur = [], local_sha
    while cur:
        chain.append(cur)
        _, _, _ = git('rev-parse', '--verify', cur + '^')
        out, _, rc = git('rev-parse', '--verify', cur + '^')
        cur = out if rc == 0 else None
    chain.reverse()
    print(f'  待推提交 {len(chain)} 个')
    remote_sha = None
    for sha in chain:
        c = raw_commit(sha)
        payload = {'message': c['message'], 'tree': c['tree'],
                   'author': c['author'], 'committer': c['committer']}
        if c['parent']:
            payload['parents'] = [c['parent']]
        else:
            payload['parents'] = []
        # 父提交必须是远端已有的对象
        if c['parent']:
            try:
                api('GET', f'/repos/{repo}/git/commits/{c["parent"]}')
            except SystemExit:
                print(f'    跳过 {sha[:7]}：父提交 {c["parent"][:7]} 不在远端')
                break
        r = api('POST', f'/repos/{repo}/git/commits', payload)
        ok = r['sha'] == sha
        print(f'    {sha[:7]} → {r["sha"][:7]}  {"MATCH" if ok else "DIFF"}  {c["message"].splitlines()[0][:46]}')
        remote_sha = r['sha']
    if remote_sha:
        try:
            api('GET', f'/repos/{repo}/git/ref/heads/{branch}')
            api('PATCH', f'/repos/{repo}/git/refs/heads/{branch}', {'sha': remote_sha, 'force': True})
            print(f'  引用已更新 → {remote_sha[:7]}')
        except SystemExit as e:
            print('  分支尚不存在，创建：', e)
            api('POST', f'/repos/{repo}/git/refs', {'ref': f'refs/heads/{branch}', 'sha': remote_sha})
            print(f'  分支已创建 → {remote_sha[:7]}')
    return remote_sha




def push_all(repo, branch, files, msg, base_sha=None):
    """整仓推送：blob -> tree -> commit -> ref。files: [(rel, abs_path)]
    并发建 blob（12 线程）+ 每文件独立重试 + 按 git blob SHA 判重实现断点续传。"""
    global REPO
    REPO = repo
    import base64, hashlib
    from concurrent.futures import ThreadPoolExecutor

    def ensure_blob(rel, abs_p):
        with open(abs_p, 'rb') as f:
            data = f.read()
        local_sha = hashlib.sha1(b'blob ' + str(len(data)).encode() + bytes([0]) + data).hexdigest()
        try:
            api('GET', f'/repos/{repo}/git/blobs/{local_sha}', timeout=30)
            return rel, local_sha, True
        except SystemExit:
            b64 = base64.b64encode(data).decode('ascii')
            to = 300 if len(data) > 5 * 1024 * 1024 else 90
            sha = api('POST', f'/repos/{repo}/git/blobs',
                      {'content': b64, 'encoding': 'base64'},
                      retries=6, timeout=to)['sha']
            return rel, sha, False

    # blob API 对单个内容有大小上限（>~25MB 报 422 'input was too large'）
    # → 大文件改走 Contents API（支持到 100MB），在主推送之后单独补
    BLOB_LIMIT = 25 * 1024 * 1024
    big = []
    small = []
    for rel, ap in files:
        (big if os.path.getsize(ap) > BLOB_LIMIT else small).append((rel, ap))
    if big:
        print(f'    {len(big)} 个大文件走 Contents API：' +
              ', '.join(r for r, _ in big)[:120], flush=True)

    entries = []
    skipped = 0
    done = 0
    with ThreadPoolExecutor(max_workers=12) as pool:
        futs = [pool.submit(ensure_blob, rel, ap) for rel, ap in small]
        for fu in futs:
            rel, sha, reused = fu.result()
            entries.append({'path': rel, 'mode': '100644', 'type': 'blob', 'sha': sha})
            skipped += 1 if reused else 0
            done += 1
            if done % 100 == 0 or done == len(small):
                print(f'    {done}/{len(files)} blob 就绪（复用 {skipped}）', flush=True)
    entries.sort(key=lambda e: e['path'])
    if base_sha:
        base_tree = api('GET', f'/repos/{repo}/git/commits/{base_sha}')['tree']['sha']
        tree = api('POST', f'/repos/{repo}/git/trees', {'base_tree': base_tree, 'tree': entries})
        parents = [base_sha]
    else:
        tree = api('POST', f'/repos/{repo}/git/trees', {'tree': entries})
        parents = []
    commit = api('POST', f'/repos/{repo}/git/commits',
                 {'message': msg, 'tree': tree['sha'], 'parents': parents})
    ref_path = f'/repos/{repo}/git/refs/heads/{branch}'
    try:
        api('GET', f'/repos/{repo}/git/ref/heads/{branch}')
        api('PATCH', ref_path, {'sha': commit['sha'], 'force': True})
    except SystemExit:
        try:
            api('POST', f'/repos/{repo}/git/refs',
                {'ref': f'refs/heads/{branch}', 'sha': commit['sha']})
        except SystemExit:
            # 分支已存在 → 退回 PATCH
            api('PATCH', ref_path, {'sha': commit['sha'], 'force': True})
    print(f'  -> 提交 {commit["sha"][:7]} 已推送到 {repo}:{branch}')

    # 大文件补推（Contents API）
    for rel, ap in big:
        with open(ap, 'rb') as f:
            data = f.read()
        b64 = base64.b64encode(data).decode('ascii')
        r = api('PUT', f'/repos/{repo}/contents/{rel}',
                {'message': f'chore: 上传大文件 {rel}', 'content': b64,
                 'branch': branch}, retries=3, timeout=600)
        print(f'    大文件已上传 {rel} ({len(data)/1048576:.1f} MB) -> {r.get("commit",{}).get("sha","")[:8]}')
    return commit['sha']


def ensure_repo_initialized(repo, path='.gitignore', content='# placeholder' + chr(10)):
    """空仓库不允许用 blob API（409 Git Repository is empty）。
    先用 Contents API 放一个文件，生成首个 commit，仓库即可用 blob API。"""
    import base64
    r = api('PUT', f'/repos/{repo}/contents/{path}', {
        'message': 'chore: 初始化仓库',
        'content': base64.b64encode(content.encode('utf-8')).decode('ascii'),
        'branch': 'main',
    })
    print('  仓库已初始化，首个 commit:', r.get('commit', {}).get('sha', '')[:8])
    return r.get('commit', {}).get('sha')


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'push-chain':
        push_chain(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == 'push-all':
        import json as _j
        repo, branch = sys.argv[2], sys.argv[3]
        msg = sys.argv[4]
        listing = _j.load(open(sys.argv[5], encoding='utf-8'))
        try:
            api('GET', f'/repos/{repo}/git/ref/heads/{branch}')
        except SystemExit:
            ensure_repo_initialized(repo)
        push_all(repo, branch, [(x[0], x[1]) for x in listing], msg)
    elif cmd == 'create-repo':
        owner, name = sys.argv[2], sys.argv[3]
        private = '--private' not in sys.argv
        desc = ''
        if '--desc' in sys.argv:
            desc = sys.argv[sys.argv.index('--desc') + 1]
        r = api('POST', '/user/repos', {'name': name, 'private': private, 'auto_init': False,
                                       'description': desc, 'has_issues': True})
        print('  仓库已创建:', r['full_name'], '(private=%s)' % r['private'])
