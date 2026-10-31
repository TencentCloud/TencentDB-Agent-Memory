"""把本轮需求模型识别修正的成果写入 TDAI 记忆栈（L0 → L1/L2/L3 管线）。"""
import io, json, os, urllib.request, urllib.error

key = io.open('.admin-key', encoding='utf-8').read().strip()
TEAM, USER, AGENT = 'team-vsyicl8ds0', 'usr-vsx9qiq1xb', 'agt-vsyq5lxfxl'

DOC = """【SkyChess 需求模型识别修正 v2】本轮逆向的核心发现与修正

一、识别逻辑方向性错误（最关键）
  恒等式 pax = min(D, ASK)，LF = pax / ASK
  → LF<100% ⇒ pax<ASK ⇒ min 取 D ⇒ D = pax（精确等式，31 行）
  → LF=100% ⇒ pax=ASK ⇒ D ≥ ASK（仅下界，3 行）
  旧模型恰好用反：拿 3 个 LF=100% 行当等式锁定 K，把 31 行含信息量的等式当"供给受限"丢弃。
  后果：旧口径"复盘总误差 −4.16%"是同义反复（model_rev = a·fare·min(D,pax) 对比 a·fare·pax），
  只有模型低估 D 的行才非零 —— 它衡量"模型有没有崩"，不衡量"模型准不准"。

二、QSI 不可识别（报告列 QSI 是季度级变量、与隐含需求非单调）
  等式行 log-RMS 对比：
    D = K×price_f                 38.77%
    D = K×price_f×qsi_f(QSI)      58.30%  ← 更差
    D = K×price_f×freq^0.5        34.26%  ← 最优
    D = K×price_f×freq^0.5×qsi_f 35.22%  ← 仍更差
  ⇒ 报告列的 QSI 不进入需求函数。机理上 QSI 的需求效应是经由班次频率中介的。

三、服务频率是真实驱动项
  D ∝ freq^0.50（次线性：班次翻倍需求约 +41%），与"网络服务质量随频次提升"的机理一致。

四、运价回合内变更 = 不可消除的测量误差
  执行运价由 revenue/(a·pax) 反解，是旅客加权均价；回合内改价时与需求形成价不一致：
  价格中途下调→反解价偏低→模型高估（Simone Q2/2029 +69.9%）；
  价格中途上调→反解价偏高→模型低估（Lewis Q1/2028 −21.4%）。
  31 个等式行中 10 行偏差 >8%；剔除后 log-RMS 26.69%。

五、最终参数（等式行几何均值 + LF=100% 硬下界约束，3/3 满足）
  D = K_market × (200/fare)^eps × (freq/100)^0.50
  K: Armstrong 68505, Broonzy 26953, Ellington 11603, Fitzgerald 5951,
     Joplin 12999, Lewis 7555, Simone 9868
  eps: Lewis/Simone/Armstrong/Joplin=1.10, Fitzgerald/Ellington/Broonzy=1.05（API 逆向值）

六、连带修复（沙盘侧）
  1. 沙盘需求函数改为频率驱动、移除 QSI 乘子；guide_fare 用真实观测执行运价中位数校准
     （Armstrong 698、Joplin 154、Simone 167、Ellington 237、Fitzgerald 163、Lewis 113）。
  2. 新增湿租机制（leaseAircraft/buyOutLease）：真实游戏 CA 开局 2 架均为租赁（ROU），
     沙盘原先只有自有机，3 架远程宽体的季度持有成本（≈$8M）直接压垮全服务策略。
  3. 修复 server.mjs 的 Map/Object.keys 缺陷：sessions 是 Map，
     Object.keys(map) 返回 []，导致 reset 无法清除动态新建的席位。

七、遗留边界（诚实声明）
  · 价格弹性不可独立识别（K 与 eps 共线），沿用 API 逆向值
  · 存在未建模的市场-季度效应：同频次同价下需求可差 3 倍（Ellington Q4/2027 32,600 vs Q3/2028 10,400）
  · 等式行 D 预测 log-RMS 34.26%（剔除运价反转污染后 26.69%）"""

req = urllib.request.Request(
    'http://127.0.0.1:8420/v3/conversation/add',
    data=json.dumps({'team_id': TEAM, 'user_id': USER, 'agent_id': AGENT,
                      'session_id': 'skychess-demand-v2',
                      'messages': [{'role': 'user', 'content': DOC}]},
                     ensure_ascii=False).encode(),
    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key,
             'x-tdai-service-id': 'default'}, method='POST')
with urllib.request.urlopen(req, timeout=120) as r:
    print('  conversation/add ->', r.read().decode('utf-8', 'replace')[:200])
