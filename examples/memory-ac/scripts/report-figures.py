"""Reproducible vector figures for the A+C report (no inference/model calls).

Requirements: reportlab; pdftoppm on PATH for PNG previews.
Run from code/: python scripts/report-figures.py
SVG and PNG outputs go to ../figures; numeric inputs remain in evidence/.
"""
from pathlib import Path
from decimal import Decimal, ROUND_HALF_UP
import argparse
import hashlib
import json
import math
import shutil
import subprocess
import tempfile
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.graphics.shapes import Drawing, Rect, Line, Polygon, String, Circle, PolyLine
from reportlab.graphics import renderPDF, renderSVG

CODE = Path(__file__).resolve().parent.parent
EVIDENCE = CODE / 'evidence'
NAVY='#173352'; BLUE='#3679AD'; TEAL='#16877D'; AMBER='#C18A35'; GREY='#8798AB'
INK='#293746'; MUTED='#64758A'; PALE='#F1F6FA'; RULE='#D5E0E9'; RED='#C76755'
SERIES={'native_k5':('原生 k5',GREY),'qwen_fixed':('固定 Qwen',BLUE),
        'qa_residual':('QA 残差 R-Q',AMBER),'intervention_residual':('来源反馈 R-A',TEAL),
        'slate_active':('组合路由 S-A',NAVY)}
WIDTH=1000

def init_fonts():
    if 'Yahei' not in pdfmetrics.getRegisteredFontNames():
        font=Path('C:/Windows/Fonts/msyh.ttc')
        bold=Path('C:/Windows/Fonts/msyhbd.ttc')
        if not font.exists():
            raise RuntimeError('Provide a Chinese TrueType font by updating init_fonts() for this host.')
        pdfmetrics.registerFont(TTFont('Yahei',str(font)))
        pdfmetrics.registerFont(TTFont('YaheiB',str(bold)))

def c(value):return colors.HexColor(value)

def text(d,x,y,value,size=18,color=INK,bold=False,anchor='start'):
    d.add(String(x,y,str(value),fontName='YaheiB' if bold else 'Yahei',fontSize=size,
                 fillColor=c(color),textAnchor=anchor))

def rect(d,x,y,w,h,fill=PALE,stroke=RULE,r=9):
    d.add(Rect(x,y,w,h,rx=r,ry=r,fillColor=c(fill),strokeColor=c(stroke),strokeWidth=1))

def arrow(d,points,color=BLUE,dashed=False):
    flat=[z for p in points for z in p]
    d.add(PolyLine(flat,strokeColor=c(color),strokeWidth=2.2,fillColor=None,
                   strokeDashArray=[6,4] if dashed else None))
    x,y=points[-1];u,v=points[-2];theta=math.atan2(y-v,x-u);length=9
    pts=[x,y,x-length*math.cos(theta-.4),y-length*math.sin(theta-.4),
         x-length*math.cos(theta+.4),y-length*math.sin(theta+.4)]
    d.add(Polygon(pts,fillColor=c(color),strokeColor=c(color)))

def box(d,x,y,w,h,title,lines=(),accent=BLUE):
    rect(d,x,y,w,h,fill='#FFFFFF',stroke=RULE)
    d.add(Rect(x,y+h-6,w,6,fillColor=c(accent),strokeColor=None))
    title_size=min(20,20*(w-20)/max(1,pdfmetrics.stringWidth(title,'YaheiB',20)))
    text(d,x+w/2,y+h-30,title,title_size,accent,True,'middle')
    leading=min(25,(h-73)/max(1,len(lines)-1))
    for i,line in enumerate(lines):
        size=min(17,17*(w-18)/max(1,pdfmetrics.stringWidth(line,'Yahei',17)))
        text(d,x+w/2,y+h-58-i*leading,line,size,INK,anchor='middle')

def start(height,title,sub=''):
    d=Drawing(WIDTH,height)
    rect(d,0,0,WIDTH,height,fill='#FFFFFF',stroke=RULE)
    text(d,25,height-34,title,23,NAVY,True)
    if sub:text(d,25,height-62,sub,16,MUTED)
    return d

def legend(d,items,x,y,step=210):
    for i,(name,color) in enumerate(items):
        d.add(Rect(x+i*step,y-2,14,14,fillColor=c(color),strokeColor=None))
        text(d,x+i*step+23,y,name,17)

def architecture():
    d=start(520,'方法框架：基座不变，策略与反馈旁路接入','实线为在线数据流；虚线为离线参数或来源元数据；红线为原生回退路径。')
    box(d,25,350,180,92,'统一数据适配',['公开 / 内部会话','按查询时间截断'])
    box(d,255,350,270,92,'MemoryCore Gateway',['L0 写入 / 来源 ID','本期固定写入，L1 关闭'])
    box(d,580,350,390,92,'独立查询两条路径',['原生 k5 基线  +  P32 候选','复用基座检索，不改索引内核'])
    arrow(d,[(205,396),(255,396)])
    arrow(d,[(525,396),(580,396)])
    box(d,25,180,180,112,'来源映射',['轮次与全部分片','接受 ID / hash','来源时间'],accent=GREY)
    arrow(d,[(115,350),(115,292)],GREY,True)
    arrow(d,[(285,350),(285,307),(155,307),(155,292)],GREY,True)
    box(d,255,190,200,102,'固定 Qwen',['候选相关性评分','模型权重冻结'])
    box(d,505,180,255,112,'可学习策略层',['R-Q / R-A 残差选择','S-A：三组合间路由','≤ 5 条，≤ 80% token'],accent=TEAL)
    box(d,810,190,160,102,'格式化注入',['原生 formatter','Reader 回答'])
    arrow(d,[(775,350),(775,320),(355,320),(355,292)])
    text(d,540,324,'P32 候选',16,BLUE)
    arrow(d,[(455,240),(505,240)])
    arrow(d,[(760,240),(810,240)])
    arrow(d,[(205,224),(235,224),(235,169),(620,169),(620,180)],GREY,True)
    box(d,255,33,410,100,'离线评测与反馈训练',['来源移除 / QA 偏好 → 有界参数更新','仅训练集标签进入拟合；冻结版本后加载'],accent=TEAL)
    arrow(d,[(530,133),(530,158),(675,158),(675,180)],TEAL,True)
    arrow(d,[(810,205),(795,205),(795,145),(650,145),(650,133)],TEAL,True)
    box(d,725,33,245,100,'关闭或辅助失败',['停止辅助工作','重新查询原生 k5'],accent=RED)
    arrow(d,[(760,195),(780,195),(780,133)],RED)
    arrow(d,[(910,133),(910,190)],RED)
    return d

def loop():
    d=start(410,'整体流程：评测、反馈、学习、冻结、同批验证','来源反馈闭环；示例计数对应扩展组合层训练。验证标签不回流到本轮拟合。')
    xs=[22,221,420,619,818];w=160
    labels=[('训练任务池',['272 道训练题','组级隔离']),('机会筛查',['44 道匹配题','149 个匹配机会']),
            ('固定采样计划',['主动 / 随机各 32 题','先定计划，再做干预']),('三上下文评测',['原始与两种移除','固定 Reader / Judge']),
            ('提取有效反馈',['原始、删对照：1','删支持：0'])]
    for x,(title,lines) in zip(xs,labels):box(d,x,220,w,103,title,lines,TEAL if x==818 else BLUE)
    for a,b in zip(xs,xs[1:]):arrow(d,[(a+w,270),(b,270)])
    box(d,778,47,200,104,'偏好构造',['主动 14 / 随机 11','记录来源与成本'],TEAL)
    box(d,524,47,205,104,'有界学习',['残差 / 组合参数','正则与容量上限'],TEAL)
    box(d,273,47,205,104,'冻结模型版本',['保存参数与协议','加载后用于检索'],TEAL)
    box(d,22,47,205,104,'同批验证与分析',['质量 / 成本 / 回退','再决定下一轮迭代'],TEAL)
    arrow(d,[(898,220),(898,151)],TEAL)
    arrow(d,[(778,99),(729,99)],TEAL)
    arrow(d,[(524,99),(478,99)],TEAL)
    arrow(d,[(273,99),(227,99)],TEAL)
    arrow(d,[(101,151),(101,220)],TEAL,True)
    text(d,117,183,'下一轮',16,TEAL)
    text(d,27,17,'评测 / 校准：556 题，冻结后比较同批模式；不自动部署，不消费保护集。',16,MUTED)
    return d

def source_data():
    out=[]
    for cohort,label in [('longmem','LongMemEval'),('beam-100K','BEAM 100K'),('beam-500K','BEAM 500K'),('beam-1M','BEAM 1M')]:
        s=json.loads((EVIDENCE/(cohort+'-summary.json')).read_text(encoding='utf8'))
        split='development' if cohort=='longmem' else 'calibration'
        out.append({'cohort':cohort,'label':label,'split':split,'modes':s['splits'][split]['modes']})
    return out

def axes(d,x,y,w,h,maximum,ticks,unit):
    for value in ticks:
        yy=y+h*value/maximum
        d.add(Line(x,yy,x+w,yy,strokeColor=c(RULE),strokeWidth=.8))
        text(d,x-12,yy-5,str(value),16,MUTED,anchor='end')
    d.add(Line(x,y,x+w,y,strokeColor=c(GREY),strokeWidth=1))
    text(d,x,y+h+19,unit,17,MUTED)

def main_results(data):
    d=start(650,'跨数据与长度分层：回答质量与注入成本','固定版本对比；LongMemEval 为开发集，BEAM 为校准集。QA 采用冻结机器判定。')
    modes=['native_k5','qwen_fixed','intervention_residual']
    legend(d,[SERIES[m] for m in modes],240,548,230)
    x=75;w=900;group=w/4;bar=48;gap=7
    axes(d,x,344,w,155,100,[0,25,50,75,100],'QA 正确率 / %')
    axes(d,x,65,w,178,3500,[0,1000,2000,3000,3500],'平均注入 token / 题')
    for j,cohort in enumerate(data):
        center=x+group*(j+.5)
        for i,mode in enumerate(modes):
            s=cohort['modes'][mode];xx=center+(i-1)*(bar+gap)-bar/2
            a=s['qa']*155
            d.add(Rect(xx,344,bar,a,fillColor=c(SERIES[mode][1]),strokeColor=None))
            text(d,xx+bar/2,344+a+8,f"{s['qa']*100:.1f}",17,anchor='middle')
            b=s['mean_tokens']/3500*178
            d.add(Rect(xx,65,bar,b,fillColor=c(SERIES[mode][1]),strokeColor=None))
            text(d,xx+bar/2,65+b+8,f"{s['mean_tokens']:.0f}",17,anchor='middle')
        n=cohort['modes']['native_k5'];r=cohort['modes']['intervention_residual']
        text(d,center,314,cohort['label'],18,NAVY,True,'middle')
        text(d,center,290,f"n={n['n']}  |  R-A +{100*(r['qa']-n['qa']):.2f} pp",16,TEAL,True,'middle')
        text(d,center,34,cohort['label'],18,NAVY,True,'middle')
    text(d,25,12,'每组使用相同问题；全部柱形轴从 0 起。R-A 相对原生节省 32.63% 至 34.51% 注入 token。',15,MUTED)
    return d

def tradeoff(data):
    part=next(x for x in data if x['cohort']=='beam-500K')['modes']
    d=start(455,'BEAM 500K：反馈学习形成不同的质量与成本取舍','180 题；同候选池、同预算的反馈增量用固定 Qwen 作参照。')
    x=90;y=81;w=855;h=265;ymin=40;ymax=52
    for v in [40,42,44,46,48,50,52]:
        yy=y+(v-ymin)/(ymax-ymin)*h
        d.add(Line(x,yy,x+w,yy,strokeColor=c(RULE),strokeWidth=.8));text(d,x-12,yy-5,str(v),16,MUTED,anchor='end')
    for v in [0,800,1600,2400,3200]:
        xx=x+w*v/3200;d.add(Line(xx,y,xx,y+h,strokeColor=c(RULE),strokeWidth=.8));text(d,xx,y-24,str(v),16,MUTED,anchor='middle')
    text(d,x,y+h+19,'QA 正确率 / %  ↑',17,MUTED)
    text(d,x+w,y-50,'平均注入 token / 题（越少越好）',17,MUTED,anchor='end')
    offsets={'native_k5':(-10,-38,'end'),'qwen_fixed':(16,7,'start'),
             'qa_residual':(-15,7,'end'),'intervention_residual':(-15,22,'end'),
             'slate_active':(18,-88,'start')}
    for mode in ['native_k5','qwen_fixed','qa_residual','intervention_residual','slate_active']:
        s=part[mode];xx=x+w*s['mean_tokens']/3200;yy=y+(s['qa']*100-ymin)/(ymax-ymin)*h
        color=SERIES[mode][1];d.add(Circle(xx,yy,6,fillColor=c(color),strokeColor=colors.white,strokeWidth=1))
        dx,dy,anchor=offsets[mode]
        short={'native_k5':'原生','qwen_fixed':'Qwen','qa_residual':'R-Q','intervention_residual':'R-A','slate_active':'S-A'}[mode]
        text(d,xx+dx,yy+dy,f"{short}  {s['correct']}/{s['n']}",18,color,True,anchor)
        text(d,xx+dx,yy+dy-23,f"{s['mean_tokens']:.1f} token",16,color,anchor=anchor)
        if mode=='slate_active':
            d.add(PolyLine([xx,yy-10,xx,yy-70,xx+12,yy-70],strokeColor=c(color),strokeWidth=1,fillColor=None))
    q=part['qwen_fixed'];r=part['qa_residual'];reduction=100*(1-r['mean_tokens']/q['mean_tokens'])
    rect(d,118,275,285,51,fill='#FFF7E9',stroke='#E7D2AF')
    assert r['correct']==q['correct']
    text(d,260,295,f"R-Q：同 {q['correct']} 题，token -{reduction:.2f}%",16,AMBER,True,'middle')
    rect(d,607,275,322,51,fill='#EAF6F3',stroke='#BDDED6')
    ra=part['intervention_residual'];ra_saving=100*(1-ra['mean_tokens']/q['mean_tokens'])
    text(d,768,295,f"R-A：+{100*(ra['qa']-q['qa']):.2f} pp，token -{ra_saving:.2f}%",16,TEAL,True,'middle')
    text(d,25,12,'散点图纵轴为 40% 至 52% 的局部范围；点为冻结观测值，配对区间见附录。',15,MUTED)
    return d

def intervention():
    datasets=[json.loads((EVIDENCE/f'A-{r}-analysis.json').read_text(encoding='utf8')) for r in ['qwen3.5-9b','qwen3-14b']]
    d=start(410,'来源作用检验：移除支持与移除对照产生不同影响','匹配样本 34 / 168（20.24%）；同题三种上下文，控制移除条数与 token。')
    legend(d,[('原上下文',GREY),('移除非支持对照',BLUE),('移除支持来源',RED)],175,319,255)
    axes(d,76,66,890,198,100,[0,25,50,75,100],'QA 正确率 / %')
    keys=['original','control_removed','support_removed'];cols=[GREY,BLUE,RED]
    for j,row in enumerate(datasets):
        center=300+j*450;s=row['splits']['all']
        for i,key in enumerate(keys):
            val=s['accuracy'][key];xx=center+(i-1)*95-34
            d.add(Rect(xx,66,68,val*198,fillColor=c(cols[i]),strokeColor=None))
            text(d,xx+34,66+val*198+9,f'{val*100:.2f}%',17,anchor='middle')
            text(d,xx+34,77,f'{round(val*34)}/34',17,'#FFFFFF',True,'middle')
        name='Qwen3.5-9B' if j==0 else 'Qwen3-14B'
        delta=-100*s['support_vs_control']['complete_delta']
        text(d,center,37,name,19,NAVY,True,'middle')
        text(d,center,12,f'来源作用量（对照 - 支持）：+{delta:.2f} pp',17,TEAL,True,'middle')
    return d

def acquisition():
    diag=json.loads((EVIDENCE/'diagnostics.json').read_text(encoding='utf8'))
    d=start(400,'固定反馈预算：主动获取的信号产率与单位成本','主动与随机各 32 题；成本为已有 QA 缓存后的条件新增 token。')
    axes(d,85,63,380,170,16,[0,4,8,12,16],'有效信号数 / 32 题')
    axes(d,600,63,340,170,14000,[0,4000,8000,12000,14000],'新增 token / 有效信号')
    for i,key in enumerate(['uniform','active']):
        v=diag['training'][key];label='随机获取' if key=='uniform' else '主动获取';color=BLUE if key=='uniform' else TEAL
        xx=163+i*188;hh=v['selective']/16*170
        d.add(Rect(xx-38,63,76,hh,fillColor=c(color),strokeColor=None))
        text(d,xx,63+hh+12,f"{v['selective']}/32",20,color,True,'middle')
        text(d,xx,36,label,18,anchor='middle')
        text(d,xx,12,f"信号率 {v['selective']/32*100:.2f}%",17,color,anchor='middle')
        xx=679+i*184;val=v['conditional_incremental_tokens_per_selective'];hh=val/14000*170
        d.add(Rect(xx-38,63,76,hh,fillColor=c(color),strokeColor=None))
        text(d,xx,63+hh+12,f'{val:,.1f}',20,color,True,'middle');text(d,xx,36,label,18,anchor='middle')
    reduction=1-diag['training']['active']['conditional_incremental_tokens_per_selective']/diag['training']['uniform']['conditional_incremental_tokens_per_selective']
    text(d,779,287,f'单位反馈成本降低 {reduction*100:.2f}%',20,TEAL,True,'middle')
    return d

def build_figures():
    init_fonts();data=source_data()
    return {'fig01-framework':architecture(),'fig02-loop':loop(),'fig03-main-results':main_results(data),
            'fig04-quality-cost':tradeoff(data),'fig05-source-intervention':intervention(),
            'fig06-feedback-efficiency':acquisition(),'fig07-learning-gains':learning_gains(data)}

def learning_gains(data):
    d=start(525,'固定 Qwen 之上的增量：学习策略如何改变质量与成本','每个分层均使用全部计划问题；左图保留正负变化，右图展示相对注入节省。')
    legend(d,[SERIES['qa_residual'],SERIES['intervention_residual']],325,431,260)
    x1=225;w1=310;x2=635;w2=290;y0=75;y1=367
    lo=-4;hi=2
    sx=lambda value:x1+(value-lo)/(hi-lo)*w1
    tx=lambda value:x2+value/20*w2
    for v in [-4,-2,0,2]:
        xx=sx(v);d.add(Line(xx,y0,xx,y1,strokeColor=c(GREY if v==0 else RULE),strokeWidth=1.5 if v==0 else .8))
        text(d,xx,y0-27,f'{v:+d}' if v else '0',16,MUTED,anchor='middle')
    for v in [0,5,10,15,20]:
        xx=tx(v);d.add(Line(xx,y0,xx,y1,strokeColor=c(RULE),strokeWidth=.8))
        text(d,xx,y0-27,str(v),16,MUTED,anchor='middle')
    text(d,x1,y1+20,'正确率变化 / pp',17,NAVY,True)
    text(d,x2,y1+20,'注入 token 节省 / %',17,NAVY,True)
    for index,row in enumerate(data):
        yy=335-index*75;q=row['modes']['qwen_fixed']
        text(d,25,yy,row['label'],18,NAVY,True)
        text(d,25,yy-24,f"n={q['n']}",15,MUTED)
        for mode,offset in [('qa_residual',10),('intervention_residual',-17)]:
            s=row['modes'][mode];delta=100*(s['qa']-q['qa']);saving=100*(1-s['mean_tokens']/q['mean_tokens'])
            color=SERIES[mode][1];cy=yy+offset
            d.add(Line(sx(0),cy,sx(delta),cy,strokeColor=c(color),strokeWidth=7))
            d.add(Circle(sx(delta),cy,4.5,fillColor=c(color),strokeColor=None))
            # Match the report's half-away-from-zero percentage-point rounding.
            delta_text=Decimal(str(delta)).quantize(Decimal('0.01'),rounding=ROUND_HALF_UP)
            text(d,sx(delta)+(10 if delta>=0 else -10),cy-5,f'{delta_text:+.2f}',16,color,delta>0,'start' if delta>=0 else 'end')
            d.add(Rect(x2,cy-7,tx(saving)-x2,14,fillColor=c(color),strokeColor=None))
            text(d,tx(saving)+9,cy-5,f'{saving:.2f}%',16,color,True)
    text(d,25,17,'相对固定 Qwen：R-Q 在四个分层均节省 >14% token；R-A 在 500K 上实现 +1.67 pp 与 3.73% 节省。',15,MUTED)
    return d

def export(out):
    out.mkdir(parents=True,exist_ok=True)
    tool=shutil.which('pdftoppm')
    if not tool:raise RuntimeError('pdftoppm is required for PNG export; PDF figures themselves are vector drawings.')
    figures=build_figures();assets={}
    with tempfile.TemporaryDirectory(prefix='memory-ac-figures-') as tmp:
        for name,drawing in figures.items():
            svg=out/(name+'.svg');renderSVG.drawToFile(drawing,str(svg))
            svg_text=svg.read_text(encoding='utf8').replace('font-family: YaheiB','font-family: Microsoft YaHei; font-weight: bold').replace('font-family: Yahei','font-family: Microsoft YaHei')
            svg.write_text(svg_text,encoding='utf8')
            pdf=Path(tmp)/(name+'.pdf');renderPDF.drawToFile(drawing,str(pdf))
            subprocess.run([tool,'-singlefile','-r','144','-png',str(pdf),str(out/name)],check=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            for ext in ['svg','png']:
                file=out/(name+'.'+ext);assets[file.name]={'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'bytes':file.stat().st_size}
    sources=['longmem-summary.json','beam-100K-summary.json','beam-500K-summary.json','beam-1M-summary.json',
             'A-qwen3.5-9b-analysis.json','A-qwen3-14b-analysis.json','diagnostics.json','protocol.json']
    data=source_data()
    numeric={r['cohort']:{m:{k:r['modes'][m][k] for k in ['n','correct','qa','mean_tokens','evidence_complete','evidence_recall']} for m in SERIES} for r in data}
    manifest={'status':'pass','figures':len(figures),'numeric_inputs':numeric,'assets':assets,
              'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'sources':{n:hashlib.sha256((EVIDENCE/n).read_bytes()).hexdigest() for n in sources},
              'labels_changed':False,'new_model_calls':0,'vector_source':True,
              'axes':'bars start at zero; quality-cost scatter labels its 40%-52% y window; learning QA deltas include both sides of zero',
              'source_judgments':'frozen machine-evaluated results; no new confidence intervals inferred'}
    (out/'figure-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'status':'pass','figures':len(figures),'directory':str(out)},ensure_ascii=False))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,default=CODE.parent/'figures');args=parser.parse_args();export(args.out)
