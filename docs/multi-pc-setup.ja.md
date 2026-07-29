# 別PCへのセットアップと運用

この環境を複数PCで使う場合は、このリポジトリを唯一の配布元にし、実行プログラム、共有設定、認証情報を分離する。

- Pi、OpenCode、Codex CLIは各PCへグローバルインストールする
- オーケストレーター本体とランチャーはこのリポジトリで管理する
- 一般的なエージェント指示と秘密情報を含まない設定だけを同期する
- Codex、OpenCode、Piの認証はPCごとに行い、認証ファイルやAPIキーはGitへ入れない

## 前提

- Git
- Node.js 22以降
- npm
- OpenAI/Codex、OpenCode Go、およびPiから使用するプロバイダーの利用権限

## 現在利用できる導入方法

Windows PowerShellでは次を実行する。

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.80.7
npm install -g opencode-ai@1.18.2
npm install -g @openai/codex

git clone https://github.com/suiso11/pi-codex-opencode-orchestrator.git
Set-Location pi-codex-opencode-orchestrator
npm install
.\scripts\pi_codex_orchestrator.ps1
```

LinuxまたはmacOSでは次を実行する。

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.80.7
npm install -g opencode-ai@1.18.2
npm install -g @openai/codex

git clone https://github.com/suiso11/pi-codex-opencode-orchestrator.git
cd pi-codex-opencode-orchestrator
npm install
scripts/pi_codex_orchestrator.sh
```

別のプロジェクトでプロジェクトローカル拡張として使う場合は、オーケストレーターを対象リポジトリへコピーする。

```bash
mkdir -p /path/to/project/.pi/extensions
cp -R .pi/extensions/opencode-orchestrator /path/to/project/.pi/extensions/
```

コピー方式では更新漏れが起きやすいため、複数PC・複数プロジェクトでの恒常運用には、後述のPiパッケージ方式を推奨する。

## PCごとの認証

認証情報はPC間でコピーせず、新しいPCでそれぞれログインする。

```bash
codex login
opencode auth login
pi
```

Piが起動したら `/login` を実行し、Codex/OpenAIプロバイダーを選択する。ログイン状態は必要に応じて次で確認する。

```bash
codex login status
opencode auth list
```

次の情報はGit、共有フォルダー、dotfilesリポジトリへ入れない。

- Codexの `auth.json`
- PiおよびOpenCodeの認証情報
- APIキー
- アクセストークンとセッショントークン
- `.env` など秘密情報を含む実設定

## モデル構成

既定の役割分担は次のとおり。

- 親オーケストレーター・最終承認: `openai-codex/gpt-5.6-sol`
- OpenCodeの通常タスク: `opencode-go/glm-5.2`
- OpenCode実装: `glm` プロファイル（`opencode-go/glm-5.2`）
- OpenCode別視点レビュー: `kimi_k3` プロファイル（`opencode-go/kimi-k3`、読み取り専用）
- 最終レビュー: `codex exec -m gpt-5.6-sol --sandbox read-only`

モデルは環境変数で上書きできる。

```bash
PI_CODEX_MODEL=openai-codex/gpt-5.6-sol
PI_OPENCODE_MODEL=opencode-go/glm-5.2
PI_OPENCODE_PROFILE_GLM=opencode-go/glm-5.2
PI_OPENCODE_PROFILE_KIMI_K3=opencode-go/kimi-k3
```

### 実行状況ダッシュボード

OpenCode workerまたはworkflowの実行中は、Piの入力欄上にダッシュボードが常時表示される。
約1秒ごとに更新され、workerごとのID、モデル、経過時間、権限モード、タスク名、最新activityと、
workflowの現在phaseを確認できる。全処理が終了すると自動で消える。設定と実行数の確認には
`/opencode-status`も利用できる。

## 共有してよい設定

個人用のprivate dotfilesリポジトリを用意し、秘密情報を含まない次のファイルだけを同期すると管理しやすい。

- 汎用的な `AGENTS.md`
- `~/.codex/config.toml` の秘密情報を含まない部分
- `~/.pi/agent/settings.json` のテンプレート
- PowerShell/Bashのエイリアスや起動関数
- 使用するCLIとモデルのバージョン一覧

Piのグローバル設定例:

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-sol",
  "defaultThinkingLevel": "high"
}
```

プロジェクト固有のビルド、テスト、サービス再起動、秘密情報の扱いは各プロジェクトの `AGENTS.md` に置く。全プロジェクト共通の短い個人ルールだけをグローバルな `AGENTS.md` に置く。

## 更新

リポジトリをcloneして使っているPCでは次を実行する。

```bash
git pull --ff-only
npm install
npm test
npm run typecheck
```

グローバルCLIを更新する場合:

```bash
pi update --self
npm update -g opencode-ai @openai/codex
```

更新後はランチャーと各CLIを確認する。

```bash
pi --version
opencode --version
codex --version
```

Windowsでは追加で次を確認する。

```powershell
.\scripts\pi_codex_orchestrator.ps1 --version
```

## 推奨する最終形: Piパッケージ化

PiはGitリポジトリをグローバルパッケージとしてインストールできる。これを使うと、各プロジェクトへの拡張コピーが不要になる。

想定する導入・更新コマンド:

```bash
pi install git:github.com/suiso11/pi-codex-opencode-orchestrator
pi update --extensions
```

この方法を有効にするには、このリポジトリの `package.json` にPiパッケージmanifestを追加する必要がある。

```json
{
  "pi": {
    "extensions": [
      ".pi/extensions/opencode-orchestrator/index.ts"
    ]
  }
}
```

manifestを追加するまでは `pi install git:...` を正式な導入手順として使用せず、前述のcloneとランチャーを使う。

## 将来追加すると便利なもの

- Windows用 `bootstrap.ps1`
- Linux/macOS用 `bootstrap.sh`
- 秘密情報を含まない設定テンプレート
- CLIのインストール、認証状態、モデル利用可否を確認する診断コマンド
- 安定版タグによるバージョン固定手順
