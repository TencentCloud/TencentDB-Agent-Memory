import io, json, os, sys, urllib.request
SRC = r'C:\Users\qjl10\Desktop\学习\德比大学\rea-skychess'
key = io.open('.admin-key', encoding='utf-8').read().strip()
FILES = [
 ('SkyChess-逆向总结报告.md','02'), ('SkyChess-分析报告-增补.md','03'),
 ('SkyChess-初始状态数据.md','04'), ('SkyChess-终局逆向总结.md','05'),
 ('逆向印证对照表.md','06'), ('缺口审计报告.md','07'),
 ('沙盘缺陷审计与修复报告.md','08'),
]
for fn, idx in FILES:
    p = os.path.join(SRC, fn)
    if not os.path.exists(p): print('  skip', fn); continue
    body = io.open(p, encoding='utf-8').read()
    req = urllib.request.Request('http://127.0.0.1:8420/v3/conversation/add',
        data=json.dumps({'team_id':'team-vsyicl8ds0','user_id':'usr-vsx9qiq1xb',
                         'agent_id':'agt-vsyq5lxfxl','session_id':'skychess-seed-'+idx,
                         'messages':[{'role':'user','content':body}]}, ensure_ascii=False).encode(),
        headers={'Content-Type':'application/json','Authorization':'Bearer '+key,
                 'x-tdai-service-id':'default'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read()); print('  OK  ', fn, '->', d.get('data',{}).get('accepted_ids'))
    except Exception as e:
        print('  ERR ', fn, e)
