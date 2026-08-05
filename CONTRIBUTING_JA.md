# コントリビューションガイド

**TencentDB Agent Memory** に興味を持っていただきありがとうございます。このドキュメントでは、
本リポジトリのすべてのオープンソースモジュール
（`MemoryCore` / `MemoryPanel` / `MemoryKnowledge` / `MemoryProxy` + SDK）に共通する
コントリビューションの流れを説明します。モジュール固有の開発手順については、
各モジュールの `CONTRIBUTING.md`（存在する場合）または `README.md` を参照してください。

## 貢献の方法

- **バグ報告**: GitHub Issues — 症状、再現手順、環境を記載してください
- **機能リクエスト**: Issues — ユースケースと期待する結果を記載してください
- **ドキュメント**: 誤字の修正、例の追加、説明の明確化
- **コード**: バグ修正、機能の実装、パフォーマンス改善

## リポジトリ構成

```
tdai-memory-openclaw-plugin/
├── MemoryCore/          # メモリカーネル（Gateway、4 層パイプライン、Skill 抽出）
├── MemoryPanel/         # チームメモリのコントロールパネル
├── MemoryKnowledge/     # ナレッジサービス（Wiki + CodeGraph）
├── MemoryProxy/         # コーディングエージェント向けの LLM リクエストプロキシ
├── sdk/memory-core/     # 公式 TypeScript / Python SDK
├── deploy/              # イメージのビルドとローカルデプロイ用スクリプト
│   ├── global-images/   # コマンド 1 つで動くローカルスタック
│   ├── dockerhub/       # Docker Hub への公開手順
│   └── panel-knowledge-combined/  # memory-hub イメージのビルド
├── INSTALL.md / INSTALL_CN.md
├── CHANGELOG.md
└── README.md / README_CN.md
```

## 前提条件

モジュールごとに構成は多少異なりますが、共通の前提は次のとおりです。

- **Node.js 22.16.0 以上**（`MemoryCore` / `MemoryPanel` / `MemoryKnowledge` /
  `MemoryProxy` はいずれも Node 22 で動作します）
- **npm** または **pnpm**（lockfile はモジュールごとに異なります）
- **Python 3.9 以上**（`sdk/memory-core/python` や v2→v3 移行スクリプト用）
- **Docker**（イメージのビルド、またはローカルで 3-in-1 スタックを動かす場合）

## 開発環境の立ち上げ

もっとも手軽な開発サイクルは、Docker でフルスタックを起動し、
対象のモジュールをローカルで書き換える方法です。

```bash
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env && $EDITOR .env
./start-all.sh
```

あとはモジュールのソースコードを編集します。各モジュールを単独で動かす方法は、
それぞれの `README.md` に記載されています（通常は `cd <module> && npm install && npm run dev`）。

## 変更の提出

1. リポジトリを Fork する
2. `master` または最新の `develop_*` ブランチから機能ブランチを切る
   ```bash
   git checkout -b fix/xxx-issue
   ```
3. 変更を加え、関連するテストを実行する
   ```bash
   cd <module>
   npm test          # または pnpm test
   ```
4. Conventional Commits + DCO サインオフでコミットする（下記参照）
5. Push して、`develop_server_team` または `master` に対して PR を作成する
   （メンテナーの最新の指示に従ってください）
6. CI とレビューを通過させ、マージする

## コミット規約

[Conventional Commits](https://www.conventionalcommits.org/) を採用しています。

```
<type>(<scope>): <subject>

<body>

Signed-off-by: Your Name <your-email@example.com>
```

### type

| type | 意味 |
|---|---|
| `feat` | 新機能 |
| `fix` | バグ修正 |
| `perf` | パフォーマンス最適化 |
| `refactor` | リファクタリング（挙動の変更なし） |
| `docs` | ドキュメント |
| `test` | テスト |
| `chore` | ビルド / 依存関係 / ツール |
| `style` | フォーマットのみ |
| `revert` | 変更の取り消し |

### scope

モジュール名またはサブシステム名を使います: `memory-core` / `panel` / `knowledge` /
`proxy` / `sdk-ts` / `sdk-py` / `deploy` / `docs`

### 例

```
feat(memory-core): add batch insert for L1 records
fix(proxy): sessionInit form retry when kernel returns 429
docs(sdk-ts): update v3 constructor examples
```

## コードスタイル

- **TypeScript**: 既存のスタイルに合わせる。コメントには *何を* ではなく *なぜ* を書く
- **Python**: 型アノテーション付きの PEP 8
- **命名**: 英語を推奨。内容がわかる名前にする
- **import の順序**: Node/Python の組み込み → サードパーティ → プロジェクト内部
- **テスト**: 新機能にはテストを追加する。バグ修正では、まずリグレッションテストを書く

## DCO サインオフ

すべてのコミットに [DCO](https://developercertificate.org/) のサインオフが必要です。

```bash
git commit -s -m "feat(memory-core): ..."
```

`Signed-off-by:` トレーラーのないコミットはマージされません。自動化するには次のように設定します。

```bash
git config user.name "Your Name"
git config user.email "your-email@example.com"
```

## セキュリティに関する問題

セキュリティ上の脆弱性を発見した場合は、公開の issue を立て**ない**でください。
[agentmemory@tencent.com](mailto:agentmemory@tencent.com) までメールでご連絡ください。速やかに対応します。

## ライセンス

コントリビューションを提出することで、その内容がプロジェクトの
[MIT License](./LICENSE) の下でライセンスされることに同意したものとみなされます。

---

あらためて、ありがとうございます。手順でわからないことがあれば、「question」の Issue を
立ててください。サポートします。
