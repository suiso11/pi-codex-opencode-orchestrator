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
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.2
npm install -g opencode-ai@1.18.18
npm install -g @openai/codex

git clone https://github.com/suiso11/pi-codex-opencode-orchestrator.git
Set-Location pi-codex-opencode-orchestrator
npm install
.\scripts\pi_codex_orchestrator.ps1
```

LinuxまたはmacOSでは次を実行する。

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.2
npm install -g opencode-ai@1.18.18
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

## Herdrステータス連携（任意）

Herdrのpane内で起動する場合だけ、次の3つを起動プロセスへ渡すと、公式CLIでオーケストレーターの状態を表示できる。3つが揃わない場合は連携しない。

```bash
HERDR_ENV=1
HERDR_PANE_ID=<pane-id>
HERDR_BIN_PATH=<herdr実行ファイルのパス>
```

状態報告は `pane report-agent`（`--source custom:pi-orch`、`--agent pi-orch`）、終了時の解放は `pane release-agent` を使う。worker/workflow実行中は `working`、判断待ちのretainedまたはcleanup-failed worktreeがあれば `blocked`、それ以外は `idle`。同じ状態の再送は行わず、seqは単調増加する。メッセージは件数だけで、プロンプト・秘密情報・リポジトリやworktreeのパスは送信しない。

CLIが未導入・失敗してもオーケストレーターは継続するfail-open設計で、診断は件数制限・パス非表示。Herdr外ではインストールや設定は不要である。

## ドキュメントコーディネータースキル

ドキュメント作業用に、プロジェクトが信頼するPiスキルが利用できる。Piは `.pi/skills/orchestrator-role-coordinator/SKILL.md` からプロジェクト単位で自動発見するため、プロジェクト発見に `package.json` への登録は不要。複数workerのロール計画、worktreeのバッチ/復旧、モデルルーティングを検討するときは `/skill:orchestrator-role-coordinator` で明示的に呼び出す。

このスキルはプログレッシブ・ディスクロージャーを使い、スクリプト・依存関係・ネットワークは追加しない。ツールを付与せず、coordinator-only・ツール・worktreeの実行時ゲートを上書きすることもない。発見はセッション開始時に行われるため、新しく追加したスキルは、実行中のPiプロセスを一度リロードまたは再起動するまで見つからない。

## モデル構成

既定の役割分担は次のとおり。

- 親オーケストレーター・最終承認: `openai-codex/gpt-5.6-sol`
- OpenCodeの通常タスク: `opencode-go/glm-5.2`
- OpenCode実装: `implementer` プロファイル（`opencode-go/glm-5.2`）
- OpenCode別視点レビュー: `reviewer` プロファイル（`opencode-go/kimi-k3`、読み取り専用）
- 検証: `tester` プロファイル（既定はworkerと同じ `opencode-go/glm-5.2`、読み取り専用・bashあり）
- Executor MCP: `PI_ORCH_ENABLE_EXECUTOR=1` と明示的な `implementer` の `executor: true` が必要（OpenCodeのみ）
- 最終レビュー: `codex exec -m gpt-5.6-sol --sandbox read-only`

モデルは環境変数で上書きできる。

```bash
PI_CODEX_MODEL=openai-codex/gpt-5.6-sol
PI_OPENCODE_MODEL=opencode-go/glm-5.2
PI_OPENCODE_PROFILE_IMPLEMENTER=opencode-go/glm-5.2
PI_OPENCODE_PROFILE_REVIEWER=opencode-go/kimi-k3
PI_OPENCODE_PROFILE_TESTER=opencode-go/glm-5.2
PI_CODEX_THINKING=medium
PI_OPENCODE_THINKING=medium
# worker子プロセスへ追加で渡す環境変数名（任意、カンマ/空白区切り）
PI_ORCH_WORKER_ENV_ALLOWLIST=
```

親・workerともに思考レベルの既定は `medium`。タスクごとに `low|medium|high` を指定できる。`reviewer` ロールは常に `high` に解決される。最終承認などリスクの高い判断では `high` を選ぶこと。`medium` は常に十分という意味ではない。

Pi内の `/orch-model` では、各worker経路についてbackendとmodelを対話的に選べる。

```text
/orch-model
/orch-model implementer pi anthropic/claude-sonnet-4-5
/orch-model reviewer pi openai-codex/gpt-5.6-sol
/orch-model worker opencode opencode-go/glm-5.2
```

`pi` backendはOpenCodeを完全に迂回し、Piで認証済みのClaude、Codexなどを直接workerとして起動する。`opencode` backendを選んだ経路だけがOpenCode CLIを使用する。

Executor MCP gatewayは、`PI_ORCH_ENABLE_EXECUTOR=1` を設定し、タスクに `executor: true` と明示的な `role: "implementer"` を指定したOpenCode workerでのみ有効になる。`PI_EXECUTOR_BIN`（未指定時は `executor`）を使い、生成される `mcp.executor` のlocal commandは `[PI_EXECUTOR_BIN || "executor", "mcp", "--elicitation-mode", "browser", "--no-artifacts", "--search-tools"]` に固定される。設定はfail closedで、ambientな `OPENCODE_CONFIG_CONTENT` は破棄し、明示的にopt-inした場合だけ生成済み `mcp.executor` を入れる。各workerはprivateな `OPENCODE_CONFIG_DIR`・`XDG_CONFIG_HOME` と `OPENCODE_DISABLE_PROJECT_CONFIG=1`、`--pure` で起動する。Pi/Collie・tester/reviewer・roleなし・無効時はspawn前にfail closedする。Executor停止時に別backendへfallbackせず、認証情報などのsecretをprompt/reportへ入れないこと。worker子プロセスは親の環境変数を全継承せず、PATH・HOME・data/auth・一時ディレクトリ・locale・CIなどのruntime変数だけを受け取る。providerの環境変数は保存済みCLI authを基本とし、必要なキーだけ`PI_ORCH_WORKER_ENV_ALLOWLIST`へ明示する。環境変数の値や名前をworker reportへ出力しないこと。

実験的なCollie backendは、タスクの `model` を `collie::provider/model` とし、`PI_ORCH_ENABLE_COLLIE=1` を明示した場合だけ利用できる。安全上、`mode: write`・`role: implementer`・`worktree: true` の組み合わせ以外は、workerやworktreeを開始する前に拒否される。実行ファイルは `PI_COLLIE_BIN`（未指定時は `collie`）。構造化promptを渡して `collie run ... --provider ... --model ... --cwd <管理対象worktree> --mode auto --json --stream-json` を起動する。stdoutの最終JSON（`answer`/`error`/`usage`）は共通report/usageへ正規化し、stderrのNDJSONはraw診断として保持しつつactivityへ要約する。Collieにtool allowlistがあるとは主張せず、既存のworktreeスコープ・統合ゲートを使う（worktreeはOSサンドボックスではない）。Collieのインストールはこのプロジェクトでは行わない。

`tester` プロファイルのモデルも同じ仕組みで設定できる: `pi-orch model tester [pi|opencode] <provider/model>`、環境変数 `PI_OPENCODE_PROFILE_TESTER`、または保存された設定。`/opencode-status` で現在のtesterプロファイルを確認できる。

ロールはタスク名から推測されない。明示的なロールは次のとおり。

- `implementer`: 書き込み可能なロール別名。宣言パスの書き込みルールに従う。
- `tester`: 独立した読み取り専用検証。テスト実行・検証コマンドのためのbashは有効だが、edit/writeツールは無効。spawnにはGit worktreeが必要で、実行前後にコンテンツベースのGit fingerprint（tracked差分・staged差分・非無視untrackedファイル）を取得し、実行後の変化を検出するとタスクをerrorにする（自動復元はしない）。これは実行後検出であってサンドボックスではない。実行中のbashによる変更や、リポジトリ外・無視ファイルへの副作用は防げない。
- `reviewer`: bashなし・editなしの厳格な読み取り専用レビュー。常に `high` 思考になる。

## 親オーケストレーター限定（coordinator-only）の強制

親エージェントは既定で有効、オプトアウトなしでcoordinator-onlyモードで動作する。親で有効なツールは、安全な計画用読み取り（`read`・`grep`・`find`・`ls`）と `opencode_*` オーケストレーションツールのみ。その他のツール呼び出し（`bash`・`edit`・`write`・`apply_patch`・`patch` を含む）は、別のpresetが再度有効化しても、実行時にブロックされる。親からの直接の `!` / `!!` bashコマンドはキャンセルされる。

各エージェントターンはシステムプロンプトでcoordinator契約の指示を受け取る。実装とコマンドベースのテスト・検証は `implementer`・`tester`・`reviewer` ロールへ委譲しなければならない。計画や最終判断のための軽微な読み取り専用調査は引き続き許可される。

`/orch-model`・`/opencode-status`・`/opencode-usage`・ライブダッシュボードなどのスラッシュコマンドは親で利用できる。子workerは別プロセスで、この親限定の制約の影響を受けない。

この動作には新しい拡張コードが必要。拡張を更新した場合は、実行中のセッションが新しいコードを使うようPiを一度リロードまたは再起動する。これはcoordinator契約のガードであってセキュリティサンドボックスではない。親をサンドボックス化するものではなく、後から追加される拡張がシステムプロンプトを変更できる点は保証されない。

## オプトインのworktree書き込み分離

`worktree: true`（`mode: write` でのみ有効）を指定すると、workerはライブの作業ツリーではなく、OS一時ディレクトリ配下のdetached Git worktreeで実行される。並列workerが実作業ツリーを直接変更しないため、互いに素なパスへの並列書き込みが安全になる。worktreeタスクが正常終了すると、変更はGitバイナリパッチとして取り出され、リポジトリのルートへ適用される。

### 単独の直接書き込みと並列の分離書き込み

- 汚れたツリーへの単独の直接（非worktree）書き込みは引き続き可能。直接書き込みはworktree統合キューを通らない。
- 並列書き込みは、実行中のすべての書き込みタスク（新規分も含む）が `worktree: true` にオプトインし、**かつ** それらの具体的なrelevant pathsが互いに素（ファイルや包含ディレクトリの重複なし）である場合のみ許可される。
- 分離なしで書き込みを並列実行しようとすると、拡張は `worktree=true` へのオプトインを促すメッセージ付きでspawnを拒否する。

### バッチのセットアップと統合

- バッチの最初のworktreeタスクはクリーンなGitルート（tracked・staged・非無視untrackedの変更がない状態）を要求し、汚れたルートでは拒否される。同じバッチの後続worktreeタスクはこのベースを共有し、バッチが開いている間（settle前）にspawnしなければならない。
- 統合は各workerのGitバイナリパッチをタスクID順でリポジトリルートへ適用する。commit・stash・resetは行わない。適用前ごとにルートのfingerprintを取得し、バッチのベースから外部でルートが変更されていればバッチをpoisonedにして、そのタスクと残りのタスクの統合を中断する。
- 統合はルートを変更するため、worktreeバッチがsettleするとルートは汚れる。次のworktreeバッチを始める前にcommitまたはcleanする。

### JSON例

単独の分離書き込みspawn:

```json
opencode_spawn({
  "name": "isolated-edit",
  "mode": "write",
  "worktree": true,
  "objective": "src/a.ts 内だけに要求された変更を実装する。",
  "relevant_paths": ["src/a.ts"],
  "expected_output": "変更したファイルと短い要約を報告する。"
})
```

読み取り専用フェーズ、1つのworktree書き込みフェーズ、その後の読み取り専用検証フェーズからなるworkflow:

```json
opencode_workflow({
  "name": "isolated-workflow",
  "phases": [
    {
      "name": "research",
      "tasks": [
        {
          "name": "inspect",
          "mode": "read_only",
          "objective": "関連モジュールを調べて制約をまとめる。",
          "relevant_paths": ["src/"],
          "expected_output": "簡潔な計画。"
        }
      ]
    },
    {
      "name": "edit",
      "tasks": [
        {
          "name": "edit-a",
          "mode": "write",
          "worktree": true,
          "objective": "変更Aを適用する。",
          "relevant_paths": ["src/a.ts"],
          "expected_output": "変更ファイルAを報告する。"
        },
        {
          "name": "edit-b",
          "mode": "write",
          "worktree": true,
          "objective": "変更Bを適用する。",
          "relevant_paths": ["src/b.ts"],
          "expected_output": "変更ファイルBを報告する。"
        }
      ]
    },
    {
      "name": "verify",
      "tasks": [
        {
          "name": "test",
          "mode": "read_only",
          "role": "tester",
          "objective": "統合後にテストを実行する。",
          "relevant_paths": ["src/"],
          "expected_output": "テスト結果。"
        }
      ]
    }
  ]
})
```

### workflowフェーズの制約

worktree書き込みはルートへ統合されるため、workflowでは厳しく制約される。

- workflowごとにworktree書き込みフェーズは最大1つ。
- worktree書き込みフェーズにはworktree書き込み（`mode: write` かつ `worktree: true`）のみを含められる。読み取り専用・tester・reviewer・直接書き込みタスクを混在させてはならない。
- worktree書き込みフェーズより前には読み取り専用フェーズのみ配置できる。
- 後続には読み取り専用/テスト/レビューや直接書き込みフェーズを置ける。worktreeフェーズは完全にsettleして統合が終わってから次のフェーズが始まる。

### 失敗と保持

- 失敗・キャンセル・タイムアウト・worker自身のHEAD移動（worktree内でのcommit）・スコープ外の変更・submodule/gitlink変更・パッチ拒否が起きたworktreeタスクは、統合も自動復元もされない。worktreeとパッチはエラー付きで保持され、手動クリーンアップのため現在セッション限定のレジストリに記録される。
- 統合成功後はworktreeと一時パッチファイルを削除する。Windowsではworktree削除後に空の `oc-worktrees` 一時ディレクトリが残ることがあるが、無害。

### worktreeクリーンアップとコンフリクトUI

実行中セッション内の保持・コンフリクトしたworktreeは `/opencode-worktrees` で管理する。

```text
/opencode-worktrees list
/opencode-worktrees status <worktree-id>
/opencode-worktrees inspect <worktree-id>
/opencode-worktrees retry <worktree-id>
/opencode-worktrees discard <worktree-id>
```

- `list` は保持されたworktreeとその状態を表示する。`status` は1つのworktreeの詳細を、`inspect` はエラーとコンフリクトの文脈を表示する。`retry` は統合を再試行し、`discard` は保持されたworktreeとパッチを削除する。
- 確認要件: 破壊的操作はTUIで確認を要求する。RPC/REST呼び出し元は明示的な確認フラグを渡す必要がある。`discard` と `retry` は破壊的操作のため、明示的な確認なしでは拒否される。
- retryの安全性:
  - 再試行されるパッチは元の現在セッション実行から取得した検証済みパッチのみ。置換パッチは受け付けない。
  - 同じリポジトリのタスクまたはバッチが実行中の間は、retryは拒否される。
  - 適用前にルートのfingerprintを再取得し `git apply --check` を実行する。統合はreset・stash・commit・3-wayマージを行わない。
  - 自動的なコンフリクト解決は行わない。コンフリクトした統合は手動解決またはdiscardのために表示される。
- クリーンアップ失敗（`cleanup-failed`）または統合成功（`rootIntegrated`）の動作: worktreeをクリーンアップできなければ後で再試行できるよう登録されたままになる。パッチがルートへ適用された場合は保持されていたworktreeが削除され、ルートは汚れたままになるため、自分でcommitまたはcleanする。
- 読み取り専用の検査は、エージェントが `inspection` ツールグループの `opencode_worktree_list` と `opencode_worktree_status` から利用できる。これらはモデル向け出力にファイルシステムパスを返さない。
- 保持されたworktreeが残っている間、ダッシュボードに「worktreeクリーンアップが必要」という警告が残ることがある。オーケストレーターのシャットダウン時に自動クリーンアップは行われない。
- レジストリは現在セッション限定。再起動/クラッシュ復旧とセッション横断のGCは先送りされる。再起動後、一時成果物はOSのクリーンアップに任せて残ることがあり、一覧には表示されず、モデル向け出力にパスも公開されない。
- worktree分離は作業ツリーの分離であり、サンドボックスではない。workerのbashが実行中に任意コマンドを実行したり、worktreeの外へ書き込むことを防げない。統合されるのは宣言スコープ内の最終stagedパッチのみ。

### ロールと拡張リロード

- `tester` と `reviewer` ロールは変更なしで読み取り専用のまま。worktree書き込み分離の影響を受けない。
- この機能には新しい拡張コードが必要。拡張を更新した場合（例: `git pull` と `npm install`）は、実行中のセッションが新しいコードを使うようPiを一度リロードする。

`/orch-model` と外部の `pi-orch model` コマンドで保存した設定は、オーケストレーターの再起動なしで実行中のPiセッションへ反映される。

- `parent` は検証直後に切り替わり、次の親リクエストから新しいモデルが使われる。
- `worker`・`implementer`・`reviewer`・`tester` の変更は新しく起動するworkerだけに反映され、実行中のworkerは起動時のモデルのまま変わらない。
- `reset`（例: `/orch-model reset worker`、`pi-orch model reset worker`）または設定削除で、対象を起動時ベースライン（環境変数の上書きがあればそれ、なければ既定値）へ戻す。
- 環境変数による上書きは次回のオーケストレーター起動時に有効になり、実行中のセッションで変更した設定はそれまでの間、優先される。

拡張コード自体を更新した場合（`git pull` と `npm install` など）は、実行中のセッションが新しい拡張コードを使うようPiを一度再起動またはリロードする。その再起動後は、`/orch-model` や `pi-orch model` による以降のモデル変更は再起動なしで反映され続ける。

### 実行状況ダッシュボード

OpenCode workerまたはworkflowの実行中は、Piの入力欄上にダッシュボードが常時表示される。
約1秒ごとに更新され、workerごとのID、モデル、経過時間、権限モード、タスク名、最新activityと、
workflowの現在phaseを確認できる。全処理が終了すると自動で消える。設定と実行数の確認には
`/opencode-status`も利用できる。実際の親・workerトークン使用量とhandoff重複は `/opencode-usage` で、
コンパクト結果で足りないときの生出力は `opencode_output` で取得できる。

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
  "defaultThinkingLevel": "medium"
}
```

ランチャーは `PI_CODEX_THINKING`（既定 `medium`）で親の思考レベルを上書きする。最終承認などでは `high` を使うこと。

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
