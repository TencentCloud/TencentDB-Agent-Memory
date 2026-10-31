"""把 SkyChess 逆向工程报告作为 raw 源文件上传到 TDAI Knowledge wiki，
随后触发 LLM ingest（自动切块 + 提炼出带标题/描述/分类的知识页 + 知识图谱）。"""
import io, json, os, subprocess, sys, time, urllib.request, urllib.error

BASE = 'http://127.0.0.1:8424/v3'
SRC = r'C:\Users\qjl10\Desktop\学习\德比大学\rea-skychess'
TEAM = 'team-vsyicl8ds0'
USER = 'usr-vsx9qiq1xb'
AGENT = 'agt-vsyq5lxfxl'
WIKI = sys.argv[1] if len(sys.argv) > 1 else 'wiki-6y730yt0'

env = subprocess.run(
    ['docker', 'inspect', 'tdai-memory-hub', '--format',
     '{{range .Config.Env}}{{println .}}{{end}}'],
    capture_output=True, text=True, encoding='utf-8', errors='replace').stdout
SK = next((l.split('=', 1)[1] for l in env.splitlines()
            if l.startswith('KNOWLEDGE_SERVICE_KEY=')), '')
if not SK:
    sys.exit('no service key')


def api(path, payload, timeout=180):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
        headers={'Content-Type': 'application/json',
                 'Authorization': 'Bearer ' + SK,
                 'x-tdai-service-id': 'default'},
        method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {'code': e.code, 'message': e.read()[:400].decode('utf-8', 'replace')}
    except Exception as e:
        return {'code': -1, 'message': str(e)}


FILES = [
    ('SkyChess-REA分析报告.md',          'SkyChess-REA分析报告.md'),
    ('SkyChess-逆向总结报告.md',          'SkyChess-逆向总结报告.md'),
    ('SkyChess-分析报告-增补.md',         'SkyChess-分析报告-增补.md'),
    ('SkyChess-初始状态数据.md',          'SkyChess-初始状态数据.md'),
    ('SkyChess-终局逆向总结.md',          'SkyChess-终局逆向总结.md'),
    ('逆向印证对照表.md',                 '逆向印证对照表.md'),
    ('缺口审计报告.md',                   '缺口审计报告.md'),
    ('沙盘缺陷审计与修复报告.md',         '沙盘缺陷审计与修复报告.md'),
]

# ── 1) 上传 raw 源文件 ──
files = []
for src, name in FILES:
    p = os.path.join(SRC, src)
    if not os.path.exists(p):
        print('  [skip]', src); continue
    content = io.open(p, encoding='utf-8').read()
    # raw/write 默认按 base64 解码；手工粘贴 MD 场景显式声明 utf8
    files.append({'filename': name, 'content': content, 'encoding': 'utf8'})
    print(f'  [read] {name}  {len(content)} 字符')

r = api('/wiki/raw/write', {'team_id': TEAM, 'wiki_id': WIKI, 'files': files})
print('  [raw/write] code=', r.get('code'), (r.get('message') or '')[:120],
      '->', json.dumps(r.get('data'), ensure_ascii=False)[:160])
if r.get('code') != 0:
    sys.exit(1)

ls = api('/wiki/raw/ls', {'wiki_id': WIKI})
items = (ls.get('data') or {}).get('items') or []
print('  [raw/ls] 源文件数 =', len(items))

# ── 2) 触发 ingest ──
r = api('/wiki/ingest', {'wiki_id': WIKI})
print('  [ingest] code=', r.get('code'), '->', json.dumps(r.get('data'), ensure_ascii=False)[:200])
if r.get('code') != 0:
    print('  ingest 失败:', r.get('message')); sys.exit(2)

# ── 3) 轮询直到完成 ──
print('\n  轮询 ingest 进度…')
last = None
for i in range(1, 61):                      # 最多 30 分钟
    time.sleep(20)
    st = api('/wiki/page/ls', {'team_id': TEAM, 'wiki_id': WIKI})
    n = len((st.get('data') or {}).get('items') or [])
    src2 = api('/wiki/raw/ls', {'wiki_id': WIKI})
    m = len((src2.get('data') or {}).get('items') or [])
    line = f'  t+{i*20}s  pages={n}  raw={m}'
    if line != last:
        print(line); last = line
    if n > 0:
        print('\n  ✓ 知识页已生成:', n)
        break
else:
    print('  ! 超时，页面数仍为 0')
