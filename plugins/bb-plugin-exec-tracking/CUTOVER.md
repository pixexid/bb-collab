# Same-id reviewed-byte cutover

This deployment runbook is valid only after PR #576 merges. It converges the
repository bytes and discipline without changing the installed id, settings,
database, or registration. BB's registration metadata continues to name the
legacy path, which becomes a symlink to the reviewed checkout. That explicit
host residual remains until [get-bb/bb#2297](https://github.com/get-bb/bb/issues/2297)
provides a native same-id source rebind. The symlink is not a second plugin
owner and this procedure does not claim that registration metadata moved.

Run every command below in one `zsh` with no omitted failures. These required
inputs identify the merged commit, its pinned deployment checkout, and a new
private evidence directory. Do not echo setting files: they contain values.

```zsh
set -euo pipefail
umask 077
: "${EXPECTED_HEAD:?set to the reviewed PR #576 merge commit}"
: "${DEPLOYED_CHECKOUT:?set to the absolute pinned bb-collab checkout}"
: "${CUTOVER_EVIDENCE_DIR:?set to a new absolute evidence directory}"

PLUGIN_ID=exec-tracking
REGISTERED_PATH=/Users/pixexid/.local/share/llm-collab/runtime/main/bb-plugins/exec-tracking
DATA_DB=/Users/pixexid/.bb/plugins/exec-tracking/data.db
CANDIDATE_PATH="$DEPLOYED_CHECKOUT/plugins/bb-plugin-exec-tracking"
RETAINED_PATH="${REGISTERED_PATH}.rollback-gh575-${EXPECTED_HEAD}"
STATE_HELPER="$CANDIDATE_PATH/scripts/cutover-state.mjs"
EXPECTED_SOURCE="path:${REGISTERED_PATH}"

case "$EXPECTED_HEAD" in (*[!0-9a-f]*|'') exit 64;; esac
test "${#EXPECTED_HEAD}" -eq 40
case "$DEPLOYED_CHECKOUT" in (/*) ;; (*) exit 64;; esac
case "$CUTOVER_EVIDENCE_DIR" in (/*) ;; (*) exit 64;; esac
test ! -e "$CUTOVER_EVIDENCE_DIR" && test ! -L "$CUTOVER_EVIDENCE_DIR"
mkdir -m 700 "$CUTOVER_EVIDENCE_DIR"
test -f "$DATA_DB"
test -d "$REGISTERED_PATH" && test ! -L "$REGISTERED_PATH"
test ! -e "$RETAINED_PATH" && test ! -L "$RETAINED_PATH"
test -x "$(command -v bb)"
test -x "$(command -v jq)"
test -x "$(command -v curl)"
```

## Bind the reviewed checkout and registration

Fetch only to prove that the pinned clean checkout is the deployed `origin/main`.
Build and compare tracked dist before touching the registered path.

```zsh
git -C "$DEPLOYED_CHECKOUT" fetch origin main
test "$(git -C "$DEPLOYED_CHECKOUT" rev-parse HEAD)" = "$EXPECTED_HEAD"
test "$(git -C "$DEPLOYED_CHECKOUT" rev-parse origin/main)" = "$EXPECTED_HEAD"
test -z "$(git -C "$DEPLOYED_CHECKOUT" status --porcelain=v1 --untracked-files=all)"
test "$(realpath "$CANDIDATE_PATH")" = "$CANDIDATE_PATH"
npm ci --prefix "$DEPLOYED_CHECKOUT"
npm run build --prefix "$CANDIDATE_PATH"
env -u BB_CLI node "$DEPLOYED_CHECKOUT/scripts/check-dist.mjs"
git -C "$DEPLOYED_CHECKOUT" diff --exit-code
test -z "$(git -C "$DEPLOYED_CHECKOUT" status --porcelain=v1 --untracked-files=all)"

bb plugin source "$PLUGIN_ID" --json > "$CUTOVER_EVIDENCE_DIR/source.before.json"
jq -e --arg source "$EXPECTED_SOURCE" \
  '.requested == $source and .resolved == $source' \
  "$CUTOVER_EVIDENCE_DIR/source.before.json" >/dev/null
test "$(realpath "$REGISTERED_PATH")" = "$REGISTERED_PATH"
bb plugin config "$PLUGIN_ID" --json > "$CUTOVER_EVIDENCE_DIR/settings.before.json"
jq -e '.ok == true and (.values | keys | sort) == ["checkoutPath", "pythonPath"]
  and (.values[] | type == "string" and length > 0)' \
  "$CUTOVER_EVIDENCE_DIR/settings.before.json" >/dev/null
bb plugin list --json > "$CUTOVER_EVIDENCE_DIR/plugins.before.json"
jq -e '[.plugins[] | select(.id == "exec-tracking")] | length == 1
  and .[0].status == "running"
  and .[0].cliCommand.name == "silent-wake"
  and .[0].app.hasApp == false' \
  "$CUTOVER_EVIDENCE_DIR/plugins.before.json" >/dev/null
(cd "$CANDIDATE_PATH" && shasum -a 256 dist/server.js dist/server.meta.json) \
  > "$CUTOVER_EVIDENCE_DIR/reviewed-dist.sha256"
```

## Establish the lull and capture source state

The Lanes HTTP surface reports every registered collaboration lane across
projects, rather than the active-writer proxy. Refuse unless it is empty. Also
refuse an open abnormal thread because reload reconciliation would otherwise
deliver a real wake. The state helper records the complete `sqlite_master`
schema, migrations, and every row of every table in stable order; it refuses
any nonzero pending row. Waiting seven seconds covers the resolver's enforced
lifetime (five-second external registry bound plus two seconds) before state is
recaptured and backed up online.

```zsh
LANES_TOKEN="$(bb plugin token lanes)"
curl -fsS -H "Authorization: Bearer $LANES_TOKEN" \
  "$BB_SERVER_URL/api/v1/plugins/lanes/http/lanes" \
  > "$CUTOVER_EVIDENCE_DIR/lanes.before.json"
jq -e 'type == "array" and length == 0' "$CUTOVER_EVIDENCE_DIR/lanes.before.json" >/dev/null
unset LANES_TOKEN
bb thread list --include-hidden --json > "$CUTOVER_EVIDENCE_DIR/threads.before.json"
jq -e '[.[] | select(.status == "error" or .status == "stopping")] | length == 0' \
  "$CUTOVER_EVIDENCE_DIR/threads.before.json" >/dev/null

node "$STATE_HELPER" capture "$DATA_DB" "$CUTOVER_EVIDENCE_DIR/state.initial.json"
sleep 7
LANES_TOKEN="$(bb plugin token lanes)"
curl -fsS -H "Authorization: Bearer $LANES_TOKEN" \
  "$BB_SERVER_URL/api/v1/plugins/lanes/http/lanes" \
  > "$CUTOVER_EVIDENCE_DIR/lanes.settled.json"
jq -e 'type == "array" and length == 0' "$CUTOVER_EVIDENCE_DIR/lanes.settled.json" >/dev/null
unset LANES_TOKEN
node "$STATE_HELPER" capture "$DATA_DB" "$CUTOVER_EVIDENCE_DIR/state.before.json"
node "$STATE_HELPER" compare \
  "$CUTOVER_EVIDENCE_DIR/state.initial.json" "$CUTOVER_EVIDENCE_DIR/state.before.json"
test ! -e "$CUTOVER_EVIDENCE_DIR/data.before.db"
node "$STATE_HELPER" backup "$DATA_DB" "$CUTOVER_EVIDENCE_DIR/data.before.db"
node "$STATE_HELPER" capture \
  "$CUTOVER_EVIDENCE_DIR/data.before.db" "$CUTOVER_EVIDENCE_DIR/state.backup.json"
node "$STATE_HELPER" compare \
  "$CUTOVER_EVIDENCE_DIR/state.before.json" "$CUTOVER_EVIDENCE_DIR/state.backup.json"
```

Do not proceed if an external heartbeat or PR-artifact producer cannot honor
this seven-second zero-lane window. Thread lifecycle producers remain safe:
the old loaded generation continues handling them while only its source path
is changed, and no registration gap is introduced.

## Switch reviewed bytes and reload once

Retain the legacy directory for rollback. Its rename is atomic within the same
parent directory. The registered path then becomes the symlink; no lifecycle,
installation, removal, or configuration command occurs before the one reload.

```zsh
mv "$REGISTERED_PATH" "$RETAINED_PATH"
ln -s "$CANDIDATE_PATH" "$REGISTERED_PATH"
test -L "$REGISTERED_PATH"
test "$(realpath "$REGISTERED_PATH")" = "$CANDIDATE_PATH"
(cd "$REGISTERED_PATH" && shasum -a 256 dist/server.js dist/server.meta.json) \
  > "$CUTOVER_EVIDENCE_DIR/registered-dist.sha256"
cmp "$CUTOVER_EVIDENCE_DIR/reviewed-dist.sha256" \
  "$CUTOVER_EVIDENCE_DIR/registered-dist.sha256"
bb plugin reload "$PLUGIN_ID" --json > "$CUTOVER_EVIDENCE_DIR/reload.json"
sleep 7
```

## Positive acceptance and isolation

The invalid-argument CLI control reaches the registered implementation but
fails in parsing before resolution, evidence writing, reservation, or wake.
It must settle inside two seconds with the exact refusal. The database snapshot
around it discriminates an accidental write.

```zsh
bb plugin source "$PLUGIN_ID" --json > "$CUTOVER_EVIDENCE_DIR/source.after.json"
cmp "$CUTOVER_EVIDENCE_DIR/source.before.json" "$CUTOVER_EVIDENCE_DIR/source.after.json"
bb plugin config "$PLUGIN_ID" --json > "$CUTOVER_EVIDENCE_DIR/settings.after.json"
cmp "$CUTOVER_EVIDENCE_DIR/settings.before.json" "$CUTOVER_EVIDENCE_DIR/settings.after.json"
bb plugin list --json > "$CUTOVER_EVIDENCE_DIR/plugins.after.json"
jq -e '[.plugins[] | select(.id == "exec-tracking")] | length == 1
  and .[0].source == "path:/Users/pixexid/.local/share/llm-collab/runtime/main/bb-plugins/exec-tracking"
  and .[0].rootDir == "/Users/pixexid/.local/share/llm-collab/runtime/main/bb-plugins/exec-tracking"
  and .[0].status == "running"
  and .[0].cliCommand.name == "silent-wake"
  and .[0].app.hasApp == false' "$CUTOVER_EVIDENCE_DIR/plugins.after.json" >/dev/null
test "$(realpath "$REGISTERED_PATH")" = "$CANDIDATE_PATH"

node "$STATE_HELPER" capture "$DATA_DB" "$CUTOVER_EVIDENCE_DIR/state.before-control.json"
node <<'NODE'
import { spawnSync } from "node:child_process";
const expected = "silent wake refused: usage: silent-wake emit --project <id> --producer <pr-artifacts|heartbeat> --semantic <sha256>\n";
const result = spawnSync("bb", ["silent-wake", "invalid"], { encoding: "utf8", timeout: 2_000 });
if (result.error || result.signal || result.status !== 1 || result.stdout !== "" || result.stderr !== expected) process.exit(1);
NODE
node "$STATE_HELPER" capture "$DATA_DB" "$CUTOVER_EVIDENCE_DIR/state.after.json"
node "$STATE_HELPER" compare \
  "$CUTOVER_EVIDENCE_DIR/state.before.json" "$CUTOVER_EVIDENCE_DIR/state.after.json"

bb plugin disable "$PLUGIN_ID"
bb plugin list --json > "$CUTOVER_EVIDENCE_DIR/plugins.isolated.json"
jq -e '([.plugins[] | select(.id == "exec-tracking")] | length == 1 and .[0].enabled == false)
  and ([.plugins[] | select(.id == "bb-collab" or .id == "threads-list" or .id == "lanes" or .id == "operator-inbox")]
    | length == 4 and all(.status == "running"))' \
  "$CUTOVER_EVIDENCE_DIR/plugins.isolated.json" >/dev/null
bb plugin enable "$PLUGIN_ID"
sleep 7
bb plugin list --json > "$CUTOVER_EVIDENCE_DIR/plugins.enabled.json"
jq -e '([.plugins[] | select(.id == "exec-tracking")] | length == 1 and .[0].status == "running")
  and ([.plugins[] | select(.id == "bb-collab" or .id == "threads-list" or .id == "lanes" or .id == "operator-inbox")]
    | length == 4 and all(.status == "running"))' \
  "$CUTOVER_EVIDENCE_DIR/plugins.enabled.json" >/dev/null
bb plugin config "$PLUGIN_ID" --json > "$CUTOVER_EVIDENCE_DIR/settings.enabled.json"
cmp "$CUTOVER_EVIDENCE_DIR/settings.before.json" "$CUTOVER_EVIDENCE_DIR/settings.enabled.json"
node "$STATE_HELPER" capture "$DATA_DB" "$CUTOVER_EVIDENCE_DIR/state.enabled.json"
node "$STATE_HELPER" compare \
  "$CUTOVER_EVIDENCE_DIR/state.before.json" "$CUTOVER_EVIDENCE_DIR/state.enabled.json"
```

Keep `RETAINED_PATH` and the private evidence directory through the observation
window. The procedure never uses observed row counts as authority: whatever
complete ordered population exists at cutover must compare byte-for-byte.

## Roll back

Keep lanes at zero. The replacement remains loaded while the filesystem pointer
is restored, then the retained implementation is reloaded. Do not restore the
database unless comparison actually failed.

```zsh
test -L "$REGISTERED_PATH"
test "$(realpath "$REGISTERED_PATH")" = "$CANDIDATE_PATH"
test -d "$RETAINED_PATH" && test ! -L "$RETAINED_PATH"
unlink "$REGISTERED_PATH"
mv "$RETAINED_PATH" "$REGISTERED_PATH"
test "$(realpath "$REGISTERED_PATH")" = "$REGISTERED_PATH"
bb plugin reload "$PLUGIN_ID" --json > "$CUTOVER_EVIDENCE_DIR/rollback-reload.json"
sleep 7
bb plugin config "$PLUGIN_ID" --json > "$CUTOVER_EVIDENCE_DIR/settings.rollback.json"
cmp "$CUTOVER_EVIDENCE_DIR/settings.before.json" "$CUTOVER_EVIDENCE_DIR/settings.rollback.json"
bb plugin source "$PLUGIN_ID" --json > "$CUTOVER_EVIDENCE_DIR/source.rollback.json"
cmp "$CUTOVER_EVIDENCE_DIR/source.before.json" "$CUTOVER_EVIDENCE_DIR/source.rollback.json"
node "$STATE_HELPER" capture "$DATA_DB" "$CUTOVER_EVIDENCE_DIR/state.rollback.json"
node "$STATE_HELPER" compare \
  "$CUTOVER_EVIDENCE_DIR/state.before.json" "$CUTOVER_EVIDENCE_DIR/state.rollback.json"
bb plugin list --json > "$CUTOVER_EVIDENCE_DIR/plugins.rollback.json"
jq -e '[.plugins[] | select(.id == "exec-tracking")] | length == 1
  and .[0].status == "running"
  and .[0].cliCommand.name == "silent-wake"
  and .[0].app.hasApp == false' "$CUTOVER_EVIDENCE_DIR/plugins.rollback.json" >/dev/null
LANES_TOKEN="$(bb plugin token lanes)"
curl -fsS -H "Authorization: Bearer $LANES_TOKEN" \
  "$BB_SERVER_URL/api/v1/plugins/lanes/http/lanes" \
  > "$CUTOVER_EVIDENCE_DIR/lanes.rollback.json"
jq -e 'type == "array" and length == 0' "$CUTOVER_EVIDENCE_DIR/lanes.rollback.json" >/dev/null
unset LANES_TOKEN
```

If database comparison failed and the online backup must be restored, do so
instead of the ordinary rollback and only while no implementation holds it.
This ordering unloads the replacement, restores the retained source path,
atomically replaces the database from the online backup, and loads the retained
generation. Settings are never changed.

```zsh
FAILED_DB="${DATA_DB}.failed-gh575-${EXPECTED_HEAD}"
test -L "$REGISTERED_PATH"
test "$(realpath "$REGISTERED_PATH")" = "$CANDIDATE_PATH"
test -d "$RETAINED_PATH" && test ! -L "$RETAINED_PATH"
test ! -e "$FAILED_DB" && test ! -L "$FAILED_DB"
bb plugin disable "$PLUGIN_ID"
unlink "$REGISTERED_PATH"
mv "$RETAINED_PATH" "$REGISTERED_PATH"
test ! -e "${DATA_DB}-wal" && test ! -L "${DATA_DB}-wal"
test ! -e "${DATA_DB}-shm" && test ! -L "${DATA_DB}-shm"
mv "$DATA_DB" "$FAILED_DB"
node "$STATE_HELPER" backup "$CUTOVER_EVIDENCE_DIR/data.before.db" "$DATA_DB"
test "$(realpath "$REGISTERED_PATH")" = "$REGISTERED_PATH"
bb plugin enable "$PLUGIN_ID"
sleep 7
bb plugin config "$PLUGIN_ID" --json > "$CUTOVER_EVIDENCE_DIR/settings.restored.json"
cmp "$CUTOVER_EVIDENCE_DIR/settings.before.json" "$CUTOVER_EVIDENCE_DIR/settings.restored.json"
bb plugin source "$PLUGIN_ID" --json > "$CUTOVER_EVIDENCE_DIR/source.restored.json"
cmp "$CUTOVER_EVIDENCE_DIR/source.before.json" "$CUTOVER_EVIDENCE_DIR/source.restored.json"
node "$STATE_HELPER" capture "$DATA_DB" "$CUTOVER_EVIDENCE_DIR/state.restored.json"
node "$STATE_HELPER" compare \
  "$CUTOVER_EVIDENCE_DIR/state.before.json" "$CUTOVER_EVIDENCE_DIR/state.restored.json"
bb plugin list --json > "$CUTOVER_EVIDENCE_DIR/plugins.restored.json"
jq -e '([.plugins[] | select(.id == "exec-tracking")] | length == 1 and .[0].status == "running")
  and ([.plugins[] | select(.id == "bb-collab" or .id == "threads-list" or .id == "lanes" or .id == "operator-inbox")]
    | length == 4 and all(.status == "running"))' \
  "$CUTOVER_EVIDENCE_DIR/plugins.restored.json" >/dev/null

LANES_TOKEN="$(bb plugin token lanes)"
curl -fsS -H "Authorization: Bearer $LANES_TOKEN" \
  "$BB_SERVER_URL/api/v1/plugins/lanes/http/lanes" \
  > "$CUTOVER_EVIDENCE_DIR/lanes.restored.json"
jq -e 'type == "array" and length == 0' "$CUTOVER_EVIDENCE_DIR/lanes.restored.json" >/dev/null
unset LANES_TOKEN
```
