"""把 SkyChess 逆向工程成果写入 TDAI 记忆栈：
  L2 场景（scenario/write）—— 8 份报告各自成文件，供 agent 按场景导航读取
  L3 核心（core/write）    —— 一份核心知识锚点，长期驻留
  L1 原子（conversation/add → L1 抽取器）—— 关键事实交给 LLM 抽成原子记忆
"""
import io, json, os, subprocess, sys, time, urllib.request, urllib.error

CORE = 'http://127.0.0.1:8420/v3'
SRC = r'C:\Users\qjl10\Desktop\学习\德比大学\rea-skychess'
TEAM = 'team-vsyicl8ds0'
USER = 'usr-vsx9qiq1xb'
AGENT = 'agt-vsyq5lxfxl'
TASK = 'default'
ISO = {'team_id': TEAM, 'user_id': USER, 'agent_id': AGENT, 'task_id': TASK}

key = subprocess.run(
    ['docker', 'exec', 'tdai-memory-core', 'cat', '/data/tdai-memory/.admin-key'],
    capture_output=True, text=True, encoding='utf-8', errors='replace').stdout.strip()
if not key:
    key = io.open(r'C:\Users\qjl10\TencentDB-Agent-Memory\deploy\global-images\.admin-key',
                  encoding='utf-8').read().strip()


def api(path, payload, timeout=120):
    req = urllib.request.Request(
        CORE + path,
        data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
        headers={'Content-Type': 'application/json',
                 'Authorization': 'Bearer ' + key,
                 'x-tdai-service-id': 'default'},
        method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {'code': e.code, 'message': e.read()[:300].decode('utf-8', 'replace')}
    except Exception as e:
        return {'code': -1, 'message': str(e)}


FILES = [
    ('SkyChess-REA分析报告.md',          'skychess/reports/01-rea-analysis.md'),
    ('SkyChess-逆向总结报告.md',          'skychess/reports/02-reverse-summary.md'),
    ('SkyChess-分析报告-增补.md',         'skychess/reports/03-analysis-supplement.md'),
    ('SkyChess-初始状态数据.md',          'skychess/reports/04-initial-state.md'),
    ('SkyChess-终局逆向总结.md',          'skychess/reports/05-final-state.md'),
    ('逆向印证对照表.md',                 'skychess/reports/06-cross-validation.md'),
    ('缺口审计报告.md',                   'skychess/reports/07-gap-audit.md'),
    ('沙盘缺陷审计与修复报告.md',         'skychess/reports/08-sandbox-defect-audit.md'),
]

# ─────────── L2 场景：逐份写入 ───────────
print('=== L2 场景写入 ===')
ok = 0
for fname, path in FILES:
    p = os.path.join(SRC, fname)
    if not os.path.exists(p):
        print('  [skip]', fname); continue
    content = io.open(p, encoding='utf-8').read()
    summary = content.strip().split('\n')[0].lstrip('# ').strip()[:180]
    r = api('/scenario/write', dict(ISO, path=path, content=content, summary=summary))
    good = r.get('code') == 0
    ok += good
    print(f'  {"OK " if good else "ERR"} {path}  v{(r.get("data") or {}).get("version","?")}'
          f'{"" if good else "  " + str(r.get("message"))[:120]}')
print(f'  → {ok}/{len(FILES)} 个场景文件\n')

# ─────────── L3 核心：知识锚点 ───────────
CORE_DOC = """# SkyChess 航空运营沙盘 —— 逆向工程核心知识锚点

## 项目定位
对真实 SkyChess 航空运营模拟系统（对局 game 285 / 航司 833 Capital Airways）做全量黑箱逆向，
反推服务端算法并复建为可运行的教学沙盘（含多小组独立席位 + 独立裁判面板）。

## 技术栈判定
- 后端：PHP / Laravel / Eloquent / MySQL / Blade，前置 Cloudflare；命名空间 `App\\`（由 `imageable_type: "App\\Market"` 证实）
- 前端：Vue + webpack(bootstrap@0) + axios；233 个模块、409,375 个 AST 节点
- API 路由模板：57 条（玩家侧 5 条 + 管理端静态 52 条）；ERD 外键 16 条
- 数据形态：7 个季度完整财务（2027Q4–2029Q2），累计收入 $183,900,966、累计净利润 $6,337,637
- 裁判参数：19 项 GM 成本参数（来自 turns[].economics）
- 事件：4 起 —— 火山 / 网络攻击 / 冰雹 / 疾病大流行
- 需求模型：10 个市场；机型目录：26 种

## 已确认的公式（逆向还原）
- 客运收入 `= 0.926228 × 运价 × 旅客`（R² = 0.983，隐含佣金 7.38%）
- `ASK = 座位 × 频次 × 航段公里`（Lewis Q2/2029 反算 17.1MM，与报表 ASK 一致）
- `ADU = 日班次 × 单程 BH`（Lewis / Simone 双市场交叉验证）
- 飞机年龄 `= acquired_at_age + (turn - acquired_at_turn) / 4`（1 回合 = 1 季度）
- 需求弹性解析 `elasticity_resolved = -(1 + 0.05e)`；`inelasticity_resolved = -(0.6i - 0.3)`（20 组样本）
- 有效燃油价阻尼 `(cur + new) / 2`；燃油对冲、备件融资加成、ROU 折旧/利息、SAF / CORSIA、所得税
- 完整 18 行损益表闭合：残差 $285,015 = 净财务费用（自有资产利息 157,318 + ROU 利息 127,698），容差 $2

## 需求模型
`D = K_market × QSI 因子 × 价格因子`（截尾需求，K 为市场基量）
K 值：Armstrong 102725、Simone 98084、Broonzy 42564、Joplin 18554、Lewis 13325、Fitzgerald 10597、Ellington 161855

## 复盘验证
7 个真实季度回放，总误差 −4.16%，多数行 0.0%。
残差集中在：Joplin 季节性未建模；Lewis Q1/2028 的 QSI 负值区间（QSI = −0.20 打断幂函数结构）。

## 已知识别边界（重要）
LF = 100% 的观测仅 3 个且分属 3 个不同市场 → 市场基量 K 与弹性 ε 共线，
**价格弹性无法从黑箱独立识别**，当前直接采用逆向得到的 API 弹性值。

## 复建成果
- 沙盘：sandbox/（server.mjs 多席位服务端 + player.html 玩家面板 + teacher.html 裁判面板）
- 引擎：rebuild/（engine.py 成本公式、demand.py 需求、events.py 事件、fares.py 运价）
- 质量：UI 30/30、多席位 13/13、双面板 19/19、10 局模拟 0 不变量违反
- 缺陷审计：13 个真实缺陷已修复（含 5 个严重建模错误），详见 scenarios/reports/08

## 教学目标（官方课件 p94）
首都航空（Low-Cost Carrier）考核：毛利率 10%、辅营占比 40%、累计利润 $6M、客座率 60%、市场份额 35%
"""

print('=== L3 核心写入 ===')
r = api('/core/write', dict(ISO, content=CORE_DOC))
print('  ', 'OK  v' + str((r.get('data') or {}).get('version')) if r.get('code') == 0
      else 'ERR ' + str(r.get('message'))[:200])
