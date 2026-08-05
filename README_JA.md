
<div align="center">

<img src="./assets/images/logo.png" alt="TencentDB Agent Memory" width="880" />

### Agents remember. Humans innovate.

<a href="https://trendshift.io/repositories/29310?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-29310" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/29310" alt="TencentCloud%2FTencentDB-Agent-Memory | Trendshift" width="250" height="55"/></a>

[![npm](https://img.shields.io/npm/v/@tencentdb-agent-memory/memory-tencentdb?color=blue)](https://www.npmjs.com/package/@tencentdb-agent-memory/memory-tencentdb)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E=22.16-brightgreen)](https://nodejs.org/)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-%3E=2026.3.13-orange)](https://github.com/openclaw/openclaw)
[![Hermes](https://img.shields.io/badge/Hermes-Gateway-7B61FF)](https://hermes-agent.nousresearch.com/docs/)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/dJQM6mKMF)

[インストール](#インストール) · [これは何？](#tencentdb-agent-memory-とは) · [チームプレイ](#プレイスタイルの一例ひとり会社のために成長するエージェントチームをつくる) · [技術的な仕組み](#技術的な仕組み) · [ベンチマーク](#ベンチマーク)

[English](./README.md) · [简体中文](./README_CN.md) · [**日本語**](./README_JA.md)

</div>

---

> **最新情報:** Team Memory Beta は急速に進化しています。数分でインストールして、さっそく試してみてください。

<td>
   <video src="https://github.com/user-attachments/assets/efb1a808-1f86-4cfe-802c-f7453f7ca938" width="100%" controls autoplay loop muted playsinline></video>
</td>

# インストール

3 つのサービス（`memory-core` + `memory-hub` + `proxy`）を一度に起動します。

```bash
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env
$EDITOR .env       # 2 組の LLM パラメータ（memory グループ + proxy グループ）を記入します
./start-all.sh     # コマンド 1 つですべて起動します。完了すると、Claude にそのまま貼り付けられる 1 行が表示されます
```

パネルを開く: [http://localhost:8125](http://localhost:8125)

インストールの詳細（Memory Hub の単独デプロイ、Proxy + Claude Code / CodeBuddy の利用方法、停止とクリーンアップ、ポート一覧など）は [**INSTALL.md**](./INSTALL.md) を参照してください（中文: [INSTALL_CN.md](./INSTALL_CN.md)）。

### 旧バージョンからのデータ移行

すでに旧リリース（v1.x / v0.x）を使っていて、既存のデータを v2.0.0 以降へ引き継ぎたい場合のために、移行ツールを用意しています。

使い方とオプションの詳細は [**データ移行ツール（v2 → v3）**](./MemoryCore/scripts/migrate-v2-to-v3/README.md) を参照してください。新規インストールの場合はスキップできます。

# TencentDB Agent Memory とは

私たちは実践的な問いから出発しました。**エージェントを使うときの繰り返し作業を、どうすれば減らせるか？**

プロジェクトの背景を一度説明したなら、新しいセッションで説明し直す必要はないはずです。すでに読んだドキュメントを、どのエージェントも 1 ページ目から読み直す必要はないはずです。うまくいったワークフローを、次回また一から見つけ直す必要もないはずです。

ここでいうメモリは、単なる「会話を覚えておくこと」以上のものです。**次のエージェントが車輪の再発明をせずに済む情報は、すべて保存し、整理し、再利用されるべきです。**

```text
既存の情報 → 再利用可能なメモリ資産 → やり取りの削減 → 手戻りの削減 → より安定した結果と高い効率
```

### 経験を蓄積し、流通させ、次のエージェントへ引き継ぐ

エージェントチームのための **Memory Hub** は、経験のライフサイクル全体をループとして閉じます。作業が資産を生み、資産がチーム内を巡り、新しいメンバーは初日からチームのセーブデータを読み込めます。

1. **資産の自動抽出**: 会話やタスクから Chat Memory と Skill を抽出し、ドキュメントやコードを Wiki と CodeGraph に変換します。そのうえで、一貫した方法で管理・レビュー・振り分けを行います。
2. **ポータブルかつマルチエージェント対応**: メモリ資産はエージェントフレームワークから切り離されています。フレームワークをまたいで移動でき、複数のエージェントやチームメンバーで共有・保守できます。
3. **コールドスタートにやさしい**: 既存のドキュメント、コードベース、エージェントの会話セッションをインポートできます。新しいエージェントチームは、ゼロから学ぶのではなく既存の経験から始められます。

### 🧠 人と文脈を覚えておく頭脳

- **Chat Memory** は好み、事実、意思決定、インタラクション履歴を保持します。
- 各エージェントは作成時に自動的に自分のメモリを持ちます。次回また自己紹介をする必要はありません。
- L0 Conversation → L1 Atom → L2 Scenario → L3 Persona と、生の会話が層ごとに蒸留されていきます。

<img width="" src="assets/images/chat_memory.cn.png" alt="image.png" />

> 「古い認証モジュールはリファクタリングしないで。モバイルがまだ使っている」——これほど高くつく文脈を、人間が毎回繰り返して伝えるのに頼るべきではありません。

### ⚡ 専門知識が蓄積される Skill ライブラリ

- 複雑な作業を終えたあと、エージェントは会話やツール呼び出しから再利用可能な Skill を抽出・管理し、必要なときに指定したエージェントのコンテキストへ読み込めます。
- Skill は単なるプロンプトの断片ではありません。バージョン、リソースファイル、トリガー条件、実行手順、検証ルールを備えています。
- 個人の Skill は既定で非公開です。レビューを経てチームに共有し、他のエージェントに割り当てられます。

<img width="" src="assets/images/skill.cn.png" alt="image.png" />

> トラブルシューティング、コードレビュー、リリースチェックリスト——一度覚えれば、チーム全体で使えます。

### 📖 ドキュメントとコードの両方を読む知識マップ

- **Wiki** は製品ドキュメント、設計仕様、運用手順書を、リンクグラフを備えた構造化ページに変換します。（Karpathy の LLM ナレッジベースから着想を得ています。）

<img src="./assets/images/wiki.cn.png" alt="image.png" />

- **CodeGraph** はコードのシンボル、ファイル、呼び出し関係、影響範囲をインデックス化します。
<img width="" src="assets/images/codegraph.cn.png" alt="image.png" />

- エージェントはコードを変更する前に、検索、読み取り、呼び出し元／呼び出し先の確認、影響分析を行えます。

> Wiki があれば、エージェントは作業に取りかかる前にファイル一覧をすべて読む必要がなくなります。CodeGraph は「コードはここにある」と伝えるだけでなく、「ここを変えるとあそこに影響するかもしれない」まで教えてくれます。

### 🛡️ 人間が制御するチームメモリパネル

- Memory Hub でチームとエージェントを作成し、メモリ資産のレビュー、共有、装備を行います。
- 所有者、バージョン、ステータス、可視性、利用回数、エージェントへの紐づけを一箇所で管理します。
- `private` は Owner だけのもの、`team` はチームメンバー全員に公開、`restricted` は User / Role / Agent の ACL によって細かくアクセスを許可します。
- ロールは 2 階層です。**グローバルの System Admin** はユーザーとチームを管理し（チーム作成、メンバー追加）、Wiki、CodeGraph、Skill などの資産管理機能も利用できます。**チームレベルのロール**には Admin（チーム管理者）と Member（一般メンバー）があり、チーム内での資産の共同作業とアクセス制御を担います。資産の所有権は Owner で管理され、Owner は自分の資産に対する管理権限を自動的に持ちます。

<img width="" src="assets/images/asset.cn.png" alt="image.png" />


## コールドスタート: セーブデータを読み込んでから作業を始める

多くのエージェントにとって最初のタスクは、あなたのプロジェクトを学び直すことです。TencentDB Agent Memory は、すでに支払い済みの学習コストをセーブデータに変えます。

<img alt="Cold Start: import codebase, docs, and history into Memory Hub" src="assets/images/flowchart3.png" />

具体的には、次の既存資産をそのままインポートし、パネル上で自動的に処理できます。

- **コードベース**: 既存のリポジトリをインポートすると、**CodeGraph** がシンボル、ファイル、呼び出し関係、影響範囲を自動でインデックス化します。
- **ドキュメントとファイル**: 関連するドキュメントやファイルをインポートすると、**Wiki** がリンクグラフ付きの構造化ページを自動生成します。
- **会話セッション**: 過去のエージェントの会話セッションをインポートすると、**Skill と Chat Memory** が再利用可能な資産として自動抽出されます。

> エージェントを毎回訓練し直すのはやめましょう。セーブデータを渡してください。

## プレイスタイルの一例: ひとり会社のために、成長するエージェントチームをつくる

Memory Hub を開いてチームを作成します。

```text
Tiny but Serious Inc.
├── 👤 あなた · 目標を決める / 意思決定する
├── 🔭 Scout · 調査する / 機会を見つける
├── 🛠 Builder · コードを書く / プロダクトをつくる
├── 🧪 Reviewer · テストする / 問題を見つける
└── 🧠 Agent Memory · チームの経験を残す
```

これは 4 つのバラバラなチャットウィンドウを開くことではありません。役割の異なるメンバーからなる、チームの蓄積された経験を引き継げる部隊を編成することです。

### まず採用し、それから装備させる

```text
🔭 Scout
   ├── ユーザーインタビューの Chat Memory
   ├── 市場調査の Wiki
   └── 競合分析の Skill

🛠 Builder
   ├── プロダクトの Wiki
   ├── プロジェクトの CodeGraph
   └── 機能デリバリーの Skill

🧪 Reviewer
   ├── 過去のインシデントの Chat Memory
   ├── プロジェクトの CodeGraph
   └── リリースチェックリストの Skill
```

役割が違えば、装備も違います。ノイズを減らし、各エージェントに本当に必要なメモリ資産だけを渡しましょう。

**会社は小さくてかまいません。経験は永遠に積み上がります。**

## チャットログの倉庫ではなく、メモリ資産

RAG は「何が見つかるか」に答えます。Team Memory はさらに「誰が使えるか、どのバージョンが有効か、どのエージェントに渡すべきか」にも答えます。

| | チャット履歴 | 一般的な RAG | TencentDB Agent Memory |
| :--- | :---: | :---: | :---: |
| セッションをまたいだユーザー理解 | △ | △ | ✅ Chat Memory |
| 蒸留された実行可能な経験 | — | — | ✅ Skill |
| ドキュメントの構造と関係 | — | △ チャンク検索 | ✅ Wiki + リンクグラフ |
| コードの呼び出しグラフと影響範囲 | — | △ テキストマッチ | ✅ CodeGraph |
| 所有者 / バージョン / ステータス | — | — | ✅ |
| チーム共有とエージェントの装備 | — | — | ✅ |
| Private / Team / ACL | — | △ | ✅ |

## Memory Hub は掲示板ではなく、コントロールパネル

| プレイスタイル | Hub でできること |
| :--- | :--- |
| **チーム編成** | チームを作成し、人とエージェントを追加し、共有の境界を定める |
| **資産ライブラリ** | Chat Memory、Skill、Wiki、CodeGraph の閲覧・検索・レビュー・管理 |
| **エージェントの装備** | エージェントごとに異なるメモリ資産を紐づけ、優先度と利用モードを調整する |
| **ナレッジ工房** | Wiki と CodeGraph を構築し、処理状況と資産のメタデータを監視する |
| **アクセス制御** | private、team、ACL ベースのアクセスを切り替え、必要に応じて共有を取り消す |

資産を開いたときに重要なのは「何が書かれているか」だけではありません。「どこから来たのか、どのバージョンか、誰に割り当てられているか、最近使われたか」も同じくらい重要です。

## ループのたびに経験が増える

<img alt="Every Loop Gains Experience: continuous accumulation, making every use smarter" src="assets/images/flowchart4.png" />

メモリはエージェントのループを動かすものではありません。次のイテレーションが前回の成果を引き継げるようにするものです。価値あるやり取りは Chat Memory に残り、実証されたワークフローは Skill に蒸留され、ドキュメントやコードの変更は Wiki の取り込みと CodeGraph の同期を通じて更新されます。

**メモリがなければ、ループは単に速く繰り返されるだけかもしれません。メモリを引き継げば、各イテレーションは前回より良くなる可能性を持ちます。**

## ひとつのエージェントチーム: 共有するのは経験であって、プライバシーではない

新しい Chat Memory と Skill は既定で非公開です。共有は明示的な操作であり、既定で漏れることはありません。

| 可視性 | 意味 |
| :--- | :--- |
| `private` | Owner だけが読める。チーム管理者でも読めない |
| `team` | チームメンバーが読める。Owner / Admin が管理できる |
| `restricted` | User / Role / Agent の ACL による細かなアクセス制御 |
| `agent` | 同じチーム内のエージェントに狙いを定めて装備させる用途 |

「リリース Skill」を Release エージェントに、「アーキテクチャ Wiki」をすべての開発エージェントに、CodeGraph を Coder と Reviewer に割り当てる、といった運用ができます。

## 技術的な仕組み

TencentDB Agent Memory は「すべてを保存すること」を目指してはいません。次の 3 つの課題を解きます。**何を残す価値があるか、誰が使えるか、そして次回どうすれば少ない検索で正しいものを引き出せるか。**

<img alt="Technical overview: layering (L0–L3), Memory Assets, Memory Hub, identity-based assembly for Agents" src="assets/images/flowchart5.png" />

### 1. メモリはフラットな記録ではなく、層をなして育つ

会話はまず L0 として保存され、その後、非同期パイプラインによって複数の粒度へと精製されます。

| レイヤー | 保存する内容 | 主な用途 |
| :--- | :--- | :--- |
| **L0 Conversation** | 完全な文脈を含む生の会話 | 正確な文言、タイムスタンプ、出典の確認 |
| **L1 Atom** | 会話から抽出した事実、好み、制約、出来事 | 実行に使える情報の正確な想起 |
| **L2 Scenario** | プロジェクトやシーンを軸にまとめた知識ブロック | 作業コンテキストの素早い復元 |
| **L3 Core / Persona** | 長期的なプロフィール、安定した傾向、高次の認識 | エージェントがユーザーとチームの文脈へ素早く入るため |

生成と検索はどちらも階層的です。通常は L2/L3 が素早いコンテキストの立ち上げを担い、特定の事実が必要になったときは BM25 + ベクトル検索 + RRF によって L1/L0 へフォールバックします。結果はさらに件数、文字数バジェット、タイムアウトによって上限が設けられ、メモリがコンテキストウィンドウを圧迫しないようになっています。

### 2. メモリはグローバルなプロンプトではなく、エージェントの装備

Chat Memory、Skill、Wiki、CodeGraph はいずれも Memory Assets として統一的に登録されます。Memory Hub は **固定バインディング + ACL** によって、あるエージェントがどの資産を使えるかを決定します。まず Team、User、Agent、可視性によって権限の範囲を絞り込み、そのうえで現在のクエリに基づいて検索します。

これにより、チームは非公開の情報をすべてさらすことなく経験を共有できます。エージェントやフレームワークを切り替えるときも、必要なのは再装備だけで、再学習は不要です。

### 3. 知識は丸ごと注入するのではなく、必要に応じて呼び出す

ドキュメントは検索可能な Wiki ページとして整理され、リンクグラフによる掘り下げに対応します。コードベースはファイル、シンボル、呼び出し関係を含む CodeGraph 資産としてインデックス化されます。エージェントはまず `/v3/tools/list` で利用できる機能を把握し、`/v3/tools/call` を使って関連するページ、ソースコード、影響経路を読み取ります。

これによってドキュメントとコードもメモリの一部になります。ただしそれらは、本当に必要なときだけコンテキストに入る、呼び出し可能なツールであり続けます。

## ベンチマーク

| ベンチマーク | TencentDB Agent Memory なし | 有効にした場合 | 相対的な改善 |
| :--- | :---: | :---: | :---: |
| **PersonaMem** | 48% | **76%** | **+59%** |

PersonaMem は、長期にわたるやり取りのあとで、エージェントがユーザー情報を正しく理解し適用できるかを測定します。

## 注意事項

- Wiki と CodeGraph は非同期で構築されます。`ready` 状態になるまで処理時間がかかります。
- CodeGraph は現時点でパブリックな HTTPS リポジトリを優先しています。プライベートリポジトリと SSH 認証情報のサポートは改善中です。
- Hub は資産の手動バインドに対応しています。メモリの完全自動ルーティングは現在も改善を重ねています。
- TencentDB Agent Memory は現在、OpenClaw、Hermes、Claude Code、CodeBuddy、および SDK 連携をサポートしています。より広範なフレームワーク間の移行はロードマップに含まれています。

## 関連ドキュメント

- [インストールガイド（完全版）](./INSTALL.md)（Memory Core + Hub + Proxy のワンクリックデプロイ）
- [データ移行ツール（v2 → v3）](./MemoryCore/scripts/migrate-v2-to-v3/README.md)（旧リリースを使っていて、既存データを移行したい場合）
- [Knowledge OpenAPI](./MemoryKnowledge/openapi.yaml)
- [コントリビューションガイド](./CONTRIBUTING_JA.md)

エージェントメモリには、まだ定まった標準がありません。バグ報告、ドキュメント、ベンチマーク、新しいフレームワークのアダプター、そして Memory Hub の創造的な使い方まで、どれも歓迎します。

---
## 謝辞

TencentDB Agent Memory は、オープンソースコミュニティの成果の上に成り立っています。

- [**CodeGraph**](https://github.com/colbymchenry/codegraph) — 私たちの CodeGraph 資産モジュールは **このプロジェクトのコードを使用しています**。事前にインデックス化されたコードグラフという設計が、私たちの実装の基礎になっています。
- [**Hermes Agent**](https://github.com/nousresearch/hermes-agent)（Nous Research） — 私たちの Skill 資産管理は **Hermes Agent の Skill 関連コードの一部を使用し、そのうえでさらに最適化を加えています**。
- [Andrej Karpathy による **「LLM Wiki」**](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — ドキュメントを LLM が保守し少しずつ育てていく成果物として扱うという発想は、私たちの Wiki レイヤーの構築方法と更新の仕方に直接影響を与えました。

これらのプロジェクトの作者とコントリビューターに感謝します。

---
## コミュニティとコントリビューション

バグ報告、機能提案、ドキュメント修正、ベンチマークの再現、エコシステム連携、プルリクエストまで、あらゆる形の貢献を歓迎します。エージェントのメモリはまだ確立された領域ではなく、コミュニティとともに築いていければと考えています。

- 🐞 **バグを見つけた、質問がある？** [GitHub Issues](https://github.com/Tencent/TencentDB-Agent-Memory/issues) に issue を立ててください。24 時間以内に返信します。
- 💡 **アイデアを共有したい？** [GitHub Discussions](https://github.com/Tencent/TencentDB-Agent-Memory/discussions) でスレッドを立ててください。
- 🛠️ **コードで貢献したい？** まず [CONTRIBUTING.md](./CONTRIBUTING_JA.md) をお読みください。
- 💬 **私たちと話したい？** [Discord コミュニティ](https://discord.gg/dJQM6mKMF) に参加して、コア開発者と直接お話しください。

---

<p align="center">
 チームが歩んできた道のりを、次のエージェントのスタートラインに。
</p>

---

## ✨ コントリビューター

> 💡 一緒に開発してくれている以下のコントリビューターに感謝します。皆さんが TencentDB Agent Memory をより良くしています。

<div align="center">
  <a href="https://github.com/TencentCloud/TencentDB-Agent-Memory/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=TencentCloud/TencentDB-Agent-Memory&columns=12&anon=1" />
  </a>

  <br /><br />
<a href="https://github.com/TencentCloud/TencentDB-Agent-Memory/issues">
  <img src="https://img.shields.io/badge/Contributions_Welcome-006eff?style=for-the-badge&logo=github&logoColor=white" alt="Contributions Welcome" />
</a>

</div>


<table width="100%">
  <tr>
    <td width="68%">
      <b>TencentDB Agent Memory が役に立ったと感じたら、ぜひスターをお願いします。</b><br />
      ご提案があれば、お気軽に issue を立てて議論してください。
    </td>
    <td width="32%" align="right">
      <img src="./assets/images/star-helper.png" alt="Star TencentDB Agent Memory" width="260" />
    </td>
  </tr>
</table>


[MIT](./LICENSE) © TencentDB Agent Memory Team
