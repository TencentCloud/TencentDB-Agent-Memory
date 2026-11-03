import{j as e,L as n,a as o}from"./index-BAPhHLqT.js";const t=`/* ===== 36 贡献者卡片去填充色 ===== */
.contrib-stats .cstat.cstat-main{
  background: transparent !important;
  background-image: none !important;
  border-color: #b7c9e6 !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}
.contrib-stats .cstat.cstat-main::before,
.contrib-stats .cstat.cstat-main::after{ display: none !important; }
.contrib-stats .cstat.cstat-main strong{ color: inherit; }

/* ===== 统计数字入场（count-up 由 JS 驱动，占位处样式） ===== */
.contrib-stats .cstat strong{
  font-variant-numeric: tabular-nums;
  will-change: contents;
}

/* ===== 贡献者卡片墙动效 ===== */
@keyframes ccph-breathe{ 0%,100%{ opacity:.45 } 50%{ opacity:1 } }

.contrib-grid .contrib-cell{
  opacity: 0;
  transform: translateY(14px);
  transition:
    opacity .55s cubic-bezier(.22,1,.36,1) var(--cc-d, 0ms),
    transform .55s cubic-bezier(.22,1,.36,1) var(--cc-d, 0ms),
    filter .25s ease;
}
.contrib-grid .contrib-cell.cc-in{
  opacity: 1;
  transform: translateY(0);
}
.contrib-grid.cc-plain .contrib-cell{
  opacity: 1;
  transform: none;
  transition: opacity .25s ease, filter .25s ease;
}

/* 卡片悬停：整体上浮 + 头像环 */
.contrib-grid .contrib-cell .cc-link{
  transition: transform .25s cubic-bezier(.22,1,.36,1);
}
.contrib-grid .contrib-cell:hover .cc-link{
  transform: translateY(-4px);
}
.contrib-grid .contrib-cell .contrib-avatar{
  transition: transform .3s cubic-bezier(.22,1,.36,1), box-shadow .3s ease;
}
.contrib-grid .contrib-cell:hover .contrib-avatar{
  transform: scale(1.08);
}
.contrib-grid .contrib-cell .contrib-avatar img{
  transition: opacity .45s ease;
}
.contrib-grid .contrib-cell .contrib-avatar i{
  animation: ccph-breathe 1.8s ease-in-out infinite;
}

/* 桌面端聚光灯：鼠标停驻 600ms 后，其他卡片降透明度并去饱和 */
@media (hover: hover){
  .contrib-grid.cc-focus:hover .contrib-cell:not(:hover),
  .contrib-grid.cc-plain.cc-focus:hover .contrib-cell:not(:hover){
    opacity: .32;
    filter: saturate(.5);
  }
}

/* Hero 水印视差（若 hero 内含 .contrib-hero-watermark，则自动位移） */
.contrib-hero .contrib-hero-watermark{
  transform: translate3d(var(--cc-px, 0), var(--cc-py, 0), 0);
  transition: transform .35s cubic-bezier(.22,1,.36,1);
  will-change: transform;
}

/* 可访问性降级 */
@media (prefers-reduced-motion: reduce){
  .contrib-grid .contrib-cell{
    opacity: 1 !important;
    transform: none !important;
    transition: none !important;
  }
  .contrib-grid .contrib-cell .contrib-avatar i{ animation: none; }
  .contrib-hero .contrib-hero-watermark{ transition: none; }
}`,c=[{login:"YOMXXX",name:"YOMXXX"},{login:"yangjj-iso",name:"redyyang"},{login:"L2ncE",name:"L2ncE"}],l="2026-10-26",a=[{login:"Yuntong8888",name:"Yuntong8888",tier:1,role:"核心维护者",desc:"功能开发 · 测试与文档",commits:66},{login:"chrishuan",name:"chrishuan",tier:1,role:"核心维护者",desc:"架构设计 · 核心功能开发",commits:61},{login:"Maxwell-Code07",name:"十五便士",tier:2,role:"核心贡献者",desc:"功能增强 · Issue 分诊",commits:23},{login:"aleronwang",name:"aleronwang",tier:3,role:"活跃贡献者",desc:"社区贡献",commits:8},{login:"YOMXXX",name:"YOMXXX",tier:3,role:"活跃贡献者",desc:"高价值 PR · 社区协作",commits:8},{login:"Xuruida",name:"Ruida Xu",tier:3,role:"活跃贡献者",desc:"功能改进",commits:5},{login:"honchow",name:"honchow",tier:3,role:"贡献者",desc:"问题修复",commits:3},{login:"nicwn",name:"Nicholas Wang",tier:3,role:"贡献者",desc:"功能改进",commits:3},{login:"RerankerGuo",name:"Ziyang Guo",tier:3,role:"贡献者",desc:"功能改进",commits:3},{login:"akhilesharora",name:"Akhilesh Arora",tier:4,role:"贡献者",desc:"问题修复",commits:2},{login:"yuanrengu",name:"Andy He",tier:4,role:"贡献者",desc:"社区贡献",commits:2},{login:"Daimin0906",name:"Daimin0906",tier:4,role:"贡献者",desc:"社区贡献",commits:2},{login:"Gout999",name:"Gout999",tier:4,role:"贡献者",desc:"社区贡献",commits:2},{login:"hot777zzz",name:"hot7",tier:4,role:"贡献者",desc:"社区贡献",commits:2},{login:null,name:"kentyhuang",tier:4,role:"贡献者",desc:"问题修复",commits:2},{login:"MicroGery",name:"MicroGrey",tier:4,role:"贡献者",desc:"问题修复",commits:2},{login:"noFloat",name:"noFloat",tier:4,role:"贡献者",desc:"问题修复",commits:2},{login:"sirenexcelsior",name:"Siren.W",tier:4,role:"贡献者",desc:"问题修复",commits:2},{login:"sK3n0b1",name:"Vsevolod Alexeev",tier:4,role:"贡献者",desc:"社区贡献",commits:2},{login:"yangjj-iso",name:"redyyang",tier:4,role:"贡献者",desc:"社区贡献",commits:2},{login:"962673247",name:"zhuangjz",tier:4,role:"贡献者",desc:"社区贡献",commits:2},{login:"adamokon",name:"Adam Okoń",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"dangzitou",name:"Dang Zitou",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"dvd233",name:"dvd233",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"Apageoflove",name:"EdgeMLHacker",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"eternity2026",name:"eternity",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"aDragon0707",name:"Evan Ma",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"fei121",name:"fei121",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"FGBKILO-AGS",name:"FGBKILO-AGS",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"iroiro147",name:"iroiro147",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"jackson-jia-914",name:"jackson-jia-914",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"jackyangjie",name:"jackyangjie",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"LeonSGP43",name:"LeonSGP",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"LovePlayCode",name:"LovePlayCode",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"LYH1921",name:"LYH1921",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"nihao123word",name:"nihao123word",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"Pomeeloo",name:"Pomeeloo",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"PorunC",name:"Porun",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"withRiver",name:"Radian",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"Rememorio",name:"Rememorio",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"rocke2020",name:"Rocke Dong",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"san-tian",name:"san-tian",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"ssynb",name:"sushuaiyu",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"tingaicompass",name:"ting",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"wgm1229",name:"wgm1229",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"Oxygen56",name:"Willow Lopez",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"HunterXing",name:"xing heng",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"ZXLyyds100",name:"Xinliang Zheng",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"xiyue1753",name:"xiyue1753",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"yu3394",name:"yu3394",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"zhangxiaoshuai98",name:"zhangxiaoshuai",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:"576657922",name:"陳方方",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:null,name:"heng.tan",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1},{login:null,name:"liyaheng",tier:4,role:"社区伙伴",desc:"社区贡献",commits:1}],r=a.length,m=216;function d({c:i}){const s=e.jsxs(e.Fragment,{children:[e.jsxs("span",{className:"contrib-avatar",children:[i.login?e.jsx("img",{src:o(`/assets/avatars/${i.login.toLowerCase()}.png`),alt:i.name,loading:"lazy"}):null,e.jsx("i",{"aria-hidden":"true",children:i.name.charAt(0).toUpperCase()})]}),e.jsx("b",{className:"cc-name",children:i.name}),e.jsx("span",{className:"cc-role",children:i.role}),e.jsx("span",{className:"cc-desc",children:i.desc}),e.jsxs("span",{className:"cc-count",children:[e.jsx("i",{"aria-hidden":"true"}),`${i.commits} 次提交`]})]});return e.jsx("div",{className:`contrib-cell t${i.tier}`,children:i.login?e.jsx("a",{className:"cc-link",href:`https://github.com/${i.login}`,target:"_blank",rel:"noopener noreferrer","aria-label":`${i.name} 的 GitHub 主页`,children:s}):e.jsx("span",{className:"cc-link",title:"提交未关联 GitHub 账号",children:s})})}function g(){return e.jsxs(e.Fragment,{children:[e.jsx("style",{children:t}),e.jsxs("main",{id:"main-content",children:[e.jsx("section",{className:"sub-hero contrib-hero",children:e.jsxs("div",{className:"page-shell",children:[e.jsxs("nav",{className:"breadcrumbs","aria-label":"面包屑",children:[e.jsx(n,{to:"/",children:"首页"}),e.jsx("i",{children:"/"}),e.jsx("span",{children:"贡献者"})]}),e.jsx("p",{className:"eyebrow",children:"Open Source Community"}),e.jsx("h1",{children:"贡献者"}),e.jsxs("p",{className:"lede",children:["Join the builders —— Agent Memory 由 ",r," 位建设者共同铸就。每一行代码、每一篇文档、每一次翻译，都让 Agent 的记忆更可靠一点。"]}),e.jsxs("div",{className:"contrib-stats",children:[e.jsxs("div",{className:"cstat cstat-main",children:[e.jsx("strong",{children:r}),e.jsx("small",{children:"贡献者"})]}),e.jsxs("div",{className:"cstat",children:[e.jsx("strong",{children:m}),e.jsx("small",{children:"次提交"})]}),e.jsxs("div",{className:"cstat",children:[e.jsx("strong",{children:"4"}),e.jsx("small",{children:"个版本迭代"})]}),e.jsxs("div",{className:"cstat",children:[e.jsx("strong",{children:"MIT"}),e.jsx("small",{children:"开源协议"})]})]}),e.jsxs("div",{className:"hero-actions",children:[e.jsx("a",{className:"button button-primary",href:"https://github.com/TencentCloud/TencentDB-Agent-Memory/issues",target:"_blank",rel:"noopener noreferrer",children:"浏览 Issue ↗"}),e.jsx(n,{to:"/docs#quick-start",className:"button button-secondary",children:"阅读快速开始"})]})]})}),e.jsx("section",{className:"section","aria-labelledby":"reviewer-title",children:e.jsxs("div",{className:"page-shell",children:[e.jsxs("div",{className:"section-heading",children:[e.jsx("p",{className:"eyebrow",children:"Reviewers"}),e.jsx("h2",{id:"reviewer-title",children:"Reviewer"}),e.jsx("p",{children:"负责社区 Pull Request 的代码评审，确认改动的正确性、兼容性与文档一致性。点击卡片访问 TA 的 GitHub 主页。"})]}),e.jsx("div",{className:"contrib-grid reviewer-grid",children:c.map(({login:i,name:s})=>e.jsx("div",{className:"contrib-cell t1",children:e.jsxs("a",{className:"cc-link",href:`https://github.com/${i}`,target:"_blank",rel:"noopener noreferrer","aria-label":`${s} 的 GitHub 主页`,children:[e.jsxs("span",{className:"contrib-avatar",children:[e.jsx("img",{src:o(`/assets/avatars/${i.toLowerCase()}.png`),alt:s,loading:"lazy"}),e.jsx("i",{"aria-hidden":"true",children:s.charAt(0).toUpperCase()})]}),e.jsx("b",{className:"cc-name",children:s}),e.jsx("span",{className:"cc-role",children:"Reviewer"}),e.jsx("span",{className:"cc-desc",children:"代码评审"})]})},i))})]})}),e.jsx("section",{className:"section","aria-labelledby":"wall-title",children:e.jsxs("div",{className:"page-shell",children:[e.jsxs("div",{className:"section-heading",children:[e.jsx("p",{className:"eyebrow",children:"Contributor Wall"}),e.jsx("h2",{id:"wall-title",children:"贡献墙"}),e.jsxs("p",{children:["按贡献层级排列——核心维护者、核心贡献者、活跃贡献者与社区伙伴。点击卡片访问 TA 的 GitHub 主页；头像加载失败时显示首字母徽标。数据同步自 GitHub 仓库提交记录（",l,"）。"]})]}),e.jsx("div",{className:"contrib-grid",children:a.map(i=>e.jsx(d,{c:i},i.login||i.name))})]})}),e.jsx("section",{className:"dark-band section","aria-labelledby":"join-title",children:e.jsxs("div",{className:"page-shell",children:[e.jsxs("div",{className:"section-heading",children:[e.jsx("p",{className:"eyebrow",children:"Join the builders"}),e.jsx("h2",{id:"join-title",children:"成为下一位共建者"}),e.jsx("p",{children:"从一个 issue 开始 —— bug 修复、文档改进与翻译都算贡献。"})]}),e.jsxs("div",{className:"builder-steps",children:[e.jsxs("div",{className:"builder-step",children:[e.jsx("span",{className:"bs-no",children:"01"}),e.jsx("h3",{children:"选择一个 Issue"}),e.jsx("p",{children:"从 good first issue 开始：bug、文档和翻译都算数，不需要读完整个代码库。"})]}),e.jsxs("div",{className:"builder-step",children:[e.jsx("span",{className:"bs-no",children:"02"}),e.jsx("h3",{children:"提交你的 PR"}),e.jsx("p",{children:"遵循贡献指南发起 Pull Request，社区会进行审查并合并；评审意见本身就是学习过程。"})]}),e.jsxs("div",{className:"builder-step",children:[e.jsx("span",{className:"bs-no",children:"03"}),e.jsx("h3",{children:"在墙上见"}),e.jsx("p",{children:"合并的贡献将在下次数据刷新时出现在这面墙上。"})]})]})]})})]})]})}export{g as default};
