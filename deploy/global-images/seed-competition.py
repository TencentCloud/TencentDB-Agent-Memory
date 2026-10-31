"""把竞争分配模型的成果写入 TDAI 记忆栈。"""
import io, json, urllib.request

key = io.open('.admin-key', encoding='utf-8').read().strip()
TEAM, USER, AGENT = 'team-vsyicl8ds0', 'usr-vsx9qiq1xb', 'agt-vsyq5lxfxl'

DOC = """【SkyChess 竞争分配模型 —— 把"竞争教学沙盘"真正做成竞争】

一、发现的结构性缺陷（此前版本的致命问题）
  原先每家航司各自 pax = min(seats, D)，D 是**全市场需求**
  → 三家可各自吃掉 100% 同一市场，总承运可达真实需求的 3 倍（重复计量）
  → 市场份额只是**报表指标**而非约束：降价不会被对手分走，加班次也不会抢份额
  → "竞争关系"实际上不存在，退化成三家各自为政的平行沙盘。

二、真实数据里有什么可用
  真实报表含 per-market 的 **Route Share** 字段（CA 在该市场的份额 %）
  → 34 个 (季度,市场) 观测点，其中 23 行"有对手"（0%<share<100%）
  → CA 的份额在 0%~100% 间剧烈波动，说明对手真实存在且动态变化
  → 网络级份额 31%~41%（官方考核目标 35% ✓ 一致）

三、权重从真实份额序列反推（rebuild/fit_competition.py）
  二航司 logit 份额比：odds_CA = exp(V_CA - V_rival)
  最小二乘 Δln(odds) = a·Δln(p) + b·Δln(f) + c·ΔQSI
    价格 a = −0.562   涨价掉份额（与 API 弹性 1.05~1.10 同量级 ✓）
    班次 b = +1.160   班次翻倍份额 +123%
    QSI  c = +0.086/点  QSI 跨 10 点 ≈ 0.86 log-odds
  过渡拟合 log-odds RMS 残差 = 0.376（残差来自对手自身变化——竞品路线级数据未捕获）

四、★ 关键认知修正：QSI 不是市场需求驱动，而是**竞争份额**驱动
  此前发现"QSI 加入需求函数反而让拟合变差"，一度判定 QSI 不可识别。
  现在解释清楚了：QSI 的作用发生在**份额层**而非**需求层**——
  同样的运价与班次，服务品质更高的航司从对手那里抢走份额。
  两者合起来才构成完整的竞争机制。

五、实现的分配模型（sandbox/engine.js allocateMarket）
  V_i   = a·ln(p_i) + b·ln(f_i) + c·QSI_i + δ_i
  share_i = softmax(V) 在同一市场的所有航司上
  pax_i  = min(seats_i, D_market × share_i)
  ⇒ 各家份额和 = 1；总承运 ≤ 市场需求（无重复计量）
  ⇒ D_market 用**市场层面**口径（客座加权均价 + 全网总班次）计算

六、竞争确实在起作用（实测）
  玩家：SIM 3班/日、票价 $120、QSI 8.0
  AI竞品 AB：自动降价至 $118 并加到 4班/日、QSI 4.2
  → 份额 49.6% vs 50.4%：AB 的低价+高频被玩家的 QSI 投资恰好抵消
  → 不投 QSI 就会被压过去 —— 这正是"经营路线不同 → 结局不同"

七、事件对各家影响不对称
  冰雹停飞的飞机，其已排班次必须作废（dropGroundedSchedules），
  否则该机仍计入班次 → 事件对被打中的航司没有真实惩罚。
  实测：玩家被冰雹命中 → 该市场班次归零 → 份额直接塌陷退出，AB 接管 100%。

八、配套机制：湿租
  真实游戏 CA 开局 2 架均为租赁（ROU），报表体现为 Net Finance Charges。
  沙盘原先只有"购买"，3 架远程宽体的季度持有成本（≈$8M）直接压垮全服务策略
  （10/10 局破产）。现补齐 leaseAircraft/buyOutLease：
  押金 2%（≈2 个月租金，贴近业惯例）+ 季租 11%/4，买断价 55%。
  UI 与 API 均已接入，并对现金不足给出明确提示。

九、遗留边界
  竞品的**路线级历史数据未捕获**（只拿到元数据），故对手效用是潜变量，
  分配模型结构正确但只部分标定；这是下一轮逆向应优先补的缺口。"""

req = urllib.request.Request(
    'http://127.0.0.1:8420/v3/conversation/add',
    data=json.dumps({'team_id': TEAM, 'user_id': USER, 'agent_id': AGENT,
                      'session_id': 'skychess-competition-v1',
                      'messages': [{'role': 'user', 'content': DOC}]},
                     ensure_ascii=False).encode(),
    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key,
             'x-tdai-service-id': 'default'}, method='POST')
with urllib.request.urlopen(req, timeout=120) as r:
    print('  conversation/add ->', r.read().decode('utf-8', 'replace')[:160])
