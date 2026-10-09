import{j as n,L as r,s}from"./index-XlZHugwC.js";const c=[{login:"chrishuan",name:"chrishuan",role:"核心维护者",desc:"架构设计 · 核心功能开发",tier:"t1",contributions:60},{login:"Yuntong8888",name:"Yuntong8888",role:"核心维护者",desc:"功能开发 · 测试与文档",tier:"t1",contributions:11},{login:"Maxwell-Code07",name:"十五便士",role:"核心贡献者",desc:"功能增强 · Issue 分诊",tier:"t2",contributions:4},{login:"YOMXXX",name:"YOMXXX",role:"活跃贡献者",desc:"高价值 PR · 社区协作",tier:"t3",contributions:5},{login:"clone-of-snake",name:"Nicholas Wang",role:"贡献者",desc:"功能改进",tier:"t3",contributions:3},{login:"Xuruida",name:"Ruida Xu",role:"贡献者",desc:"功能改进",tier:"t3",contributions:3},{login:"RerankerGuo",name:"Ziyang Guo",role:"贡献者",desc:"功能改进",tier:"t3",contributions:3},{login:"akhildawra",name:"Akhilesh Arora",role:"贡献者",desc:"问题修复",tier:"t4",contributions:2},{login:"MicroGrey",name:"MicroGrey",role:"贡献者",desc:"问题修复",tier:"t4",contributions:2},{login:"sirenexcelsior",name:"Siren.W",role:"贡献者",desc:"问题修复",tier:"t4",contributions:2},{login:"honchow",name:"honchow",role:"贡献者",desc:"问题修复",tier:"t4",contributions:2},{login:"kentyhuang",name:"kentyhuang",role:"贡献者",desc:"问题修复",tier:"t4",contributions:2},{login:"noFloat",name:"noFloat",role:"贡献者",desc:"问题修复",tier:"t4",contributions:2},{login:"Andy-He",name:"Andy He",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"Apageoflove",name:"EdgeMLHacker",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"Gout999",name:"Gout999",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:2},{login:"LYH1921",name:"LYH1921",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"LeonSGP43",name:"LeonSGP",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"LovePlayCode",name:"LovePlayCode",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"Pomeeloo",name:"Pomeeloo",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"PorunC",name:"Porun",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"withRiver",name:"Radian",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"Rememorio",name:"Rememorio",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"Rocke-Dong",name:"Rocke Dong",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"sK3n0b1",name:"Vsevolod Alexeev",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"Oxygen56",name:"Willow Lopez",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"aleronwang",name:"aleronwang",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:2},{login:"fei121",name:"fei121",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"jackson-jia-914",name:"jackson-jia-914",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"jackyangjie",name:"jackyangjie",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"san-tian",name:"san-tian",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"xiyue1753",name:"xiyue1753",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"yuanrengu",name:"yuanrengu",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"zhangxiaoshuai98",name:"zhangxiaoshuai",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"962673247",name:"zhuangjz",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:2},{login:"yangjunjie-dev",name:"杨俊杰",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"nicwn",name:"nicwn",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:3},{login:"hot777zzz",name:"hot777zzz",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:2},{login:"dangzitou",name:"dangzitou",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"aDragon0707",name:"aDragon0707",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"eternity2026",name:"eternity2026",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"iroiro147",name:"iroiro147",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"ssynb",name:"ssynb",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"tingaicompass",name:"tingaicompass",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1},{login:"yu3394",name:"yu3394",role:"社区伙伴",desc:"社区贡献",tier:"t4",contributions:1}],a={contributors:c},t=a.contributors,i={count:t.length,commits:t.reduce((e,o)=>e+(Number(o.contributions)||0),0)};function l(e){return String(e||"?").trim().charAt(0).toUpperCase()}const d=`/* ===== 36 贡献者卡片去填充色 ===== */
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
}`;function m(){return n.jsxs(n.Fragment,{children:[n.jsx("style",{children:d}),n.jsxs("main",{id:"main-content",children:[n.jsx("section",{className:"sub-hero contrib-hero",children:n.jsxs("div",{className:"page-shell",children:[n.jsxs("nav",{className:"breadcrumbs","aria-label":"面包屑",children:[n.jsx(r,{to:"/",children:"首页"}),n.jsx("i",{children:"/"}),n.jsx("span",{children:"贡献者"})]}),n.jsx("p",{className:"eyebrow",children:"Open Source Community"}),n.jsx("h1",{children:"贡献者"}),n.jsxs("p",{className:"lede",children:["Join the builders —— Agent Memory 由 ",i.count," 位建设者共同铸就。每一行代码、每一篇文档、每一次翻译，都让 Agent 的记忆更可靠一点。"]}),n.jsxs("div",{className:"contrib-stats",children:[n.jsxs("div",{className:"cstat cstat-main",children:[n.jsx("strong",{children:i.count}),n.jsx("small",{children:"贡献者"})]}),n.jsxs("div",{className:"cstat",children:[n.jsx("strong",{children:`${i.commits}+`}),n.jsx("small",{children:"次提交"})]}),n.jsxs("div",{className:"cstat",children:[n.jsx("strong",{children:s.githubSnapshot.releasesCount}),n.jsx("small",{children:"个正式版本"})]}),n.jsxs("div",{className:"cstat",children:[n.jsx("strong",{children:"MIT"}),n.jsx("small",{children:"开源协议"})]})]}),n.jsxs("div",{className:"hero-actions",children:[n.jsx("a",{className:"button button-primary",href:"https://github.com/TencentCloud/TencentDB-Agent-Memory/issues",target:"_blank",rel:"noopener noreferrer",children:"浏览 Issue ↗"}),n.jsx(r,{to:"/docs#quick-start",className:"button button-secondary",children:"阅读快速开始"})]})]})}),n.jsx("section",{className:"section","aria-labelledby":"wall-title",children:n.jsxs("div",{className:"page-shell",children:[n.jsxs("div",{className:"section-heading",children:[n.jsx("p",{className:"eyebrow",children:"Contributor Wall"}),n.jsx("h2",{id:"wall-title",children:"贡献墙"}),n.jsx("p",{children:"按贡献层级排列——核心维护者、核心贡献者、活跃贡献者与社区伙伴。点击卡片访问 TA 的 GitHub 主页；头像加载失败时显示首字母徽标。"})]}),n.jsx("div",{className:"contrib-grid",children:t.map(e=>n.jsx("div",{className:`contrib-cell ${e.tier}`,children:n.jsxs("a",{className:"cc-link",href:`https://github.com/${e.login}`,target:"_blank",rel:"noopener noreferrer","aria-label":`${e.name} 的 GitHub 主页`,children:[n.jsxs("span",{className:"contrib-avatar",children:[n.jsx("img",{src:`https://github.com/${e.login}.png`,alt:e.name,loading:"lazy"}),n.jsx("i",{"aria-hidden":"true",children:l(e.name)})]}),n.jsx("b",{className:"cc-name",children:e.name}),n.jsx("span",{className:"cc-role",children:e.role}),n.jsx("span",{className:"cc-desc",children:e.desc}),n.jsxs("span",{className:"cc-count",children:[n.jsx("i",{"aria-hidden":"true"}),`${e.contributions} 次提交`]})]})},e.login))})]})}),n.jsx("section",{className:"dark-band section","aria-labelledby":"join-title",children:n.jsxs("div",{className:"page-shell",children:[n.jsxs("div",{className:"section-heading",children:[n.jsx("p",{className:"eyebrow",children:"Join the builders"}),n.jsx("h2",{id:"join-title",children:"成为下一位共建者"}),n.jsx("p",{children:"从一个 issue 开始 —— bug 修复、文档改进与翻译都算贡献。"})]}),n.jsxs("div",{className:"builder-steps",children:[n.jsxs("div",{className:"builder-step",children:[n.jsx("span",{className:"bs-no",children:"01"}),n.jsx("h3",{children:"选择一个 Issue"}),n.jsx("p",{children:"从 good first issue 开始：bug、文档和翻译都算数，不需要读完整个代码库。"})]}),n.jsxs("div",{className:"builder-step",children:[n.jsx("span",{className:"bs-no",children:"02"}),n.jsx("h3",{children:"提交你的 PR"}),n.jsx("p",{children:"遵循贡献指南发起 Pull Request，社区会进行审查并合并；评审意见本身就是学习过程。"})]}),n.jsxs("div",{className:"builder-step",children:[n.jsx("span",{className:"bs-no",children:"03"}),n.jsx("h3",{children:"在墙上见"}),n.jsx("p",{children:"合并的贡献将在下次数据刷新时出现在这面墙上。"})]})]})]})})]})]})}export{m as default};
