#!/usr/bin/env bash
# One-off backup of CONNECTOR_CREDENTIAL_MASTER into the owner's TinyCloud Secrets (TC-3895).
#
# Security contract:
# - Never prints, echoes, logs, writes to a file or passes as a command-line argument the secret value.
# - Copies CONNECTOR_CREDENTIAL_MASTER into a non-exported shell variable and unsets the env var before
#   spawning any child process, so npx/node/tinycloud never inherit it.
# - Runs only on refs/heads/main and only after verifying auth whoami ownerDid == OWNER_DID
#   (exact chain ID and case-insensitive address).
# - Always uses pinned `npx -y -p @tinycloud/cli@1.8.0 tinycloud` with an ephemeral TC_HOME and profile
#   (connector-master-backup), never sets TC_PRIVATE_KEY, directs all CLI stdout/stderr to private temp
#   files deleted in a trap, kills the login process group on timeout/exit and runs auth logout
#   unconditionally in the EXIT trap.
# - Requests the narrowest single-name manifest: tinycloud.kv get+put on vault/secrets/CONNECTOR_CREDENTIAL_MASTER
#   and tinycloud.capabilities read on the secrets space root; no network-wide decrypt and no vault listing.
# - Add-only: refuses to overwrite an existing secret.
# - Prints only fixed status lines, the one OpenKey approval link and:
#     secret=CONNECTOR_CREDENTIAL_MASTER sha256_prefix=<8 lowercase hex> match=<yes|no|unverified>
{ set +x; } 2>/dev/null
set -u
set +e
umask 077

# Capture the secret into a non-exported shell variable and unset the exported env var immediately
# so no child process (npx, node, tinycloud, sha256sum) inherits CONNECTOR_CREDENTIAL_MASTER.
secret_value="${CONNECTOR_CREDENTIAL_MASTER:-}"
unset CONNECTOR_CREDENTIAL_MASTER
unset TC_PRIVATE_KEY

# Mask every non-empty line in GitHub Actions logs before anything else runs, using pure shell
# parameter expansion (no here-string temp file).
if [[ "${GITHUB_ACTIONS:-}" == "true" && -n "$secret_value" ]]; then
  mask_rem="$secret_value"
  while :; do
    if [[ "$mask_rem" == *$'\n'* ]]; then
      mask_line="${mask_rem%%$'\n'*}"
      mask_rem="${mask_rem#*$'\n'}"
      [[ -n "$mask_line" ]] && printf '::add-mask::%s\n' "$mask_line"
    else
      [[ -n "$mask_rem" ]] && printf '::add-mask::%s\n' "$mask_rem"
      break
    fi
  done
  unset mask_rem mask_line
fi

secret_name="CONNECTOR_CREDENTIAL_MASTER"
profile="connector-master-backup"

if [[ "${GITHUB_REF:-}" != "refs/heads/main" ]]; then
  echo "ref=refused"
  exit 1
fi

owner_did="${OWNER_DID:-}"
if [[ ! "$owner_did" =~ ^did:pkh:eip155:[0-9]+:0x[0-9a-fA-F]{40}$ ]]; then
  echo "owner_did=invalid"
  exit 1
fi

if [[ -z "$secret_value" ]]; then
  echo "secret=${secret_name} value=missing"
  exit 1
fi

source_sha256="$(printf '%s' "$secret_value" | sha256sum | awk '{print $1}')"
if [[ ! "$source_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "status=hash_failed"
  exit 1
fi
source_prefix="${source_sha256:0:8}"

approval_timeout_seconds="${TC_BACKUP_APPROVAL_TIMEOUT_SECONDS:-900}"
poll_sleep_seconds="${TC_BACKUP_POLL_SLEEP_SECONDS:-0.5}"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/tc-backup-cmk.XXXXXX")"
if [[ -z "$work_dir" || ! -d "$work_dir" ]]; then
  echo "status=tempdir_failed"
  exit 1
fi
chmod 700 "$work_dir"
export TC_HOME="$work_dir/tc-home"
mkdir -p "$TC_HOME"
chmod 700 "$TC_HOME"

# Always run the pinned CLI version through npx; never pick up an unpinned tinycloud on PATH.
tc_cmd=(npx -y -p @tinycloud/cli@1.8.0 tinycloud)

login_pid=""
login_pgid=""

stop_login() {
  if [[ -n "$login_pgid" ]]; then
    kill -TERM -- "-$login_pgid" 2>/dev/null || true
  fi
  if [[ -n "$login_pid" ]]; then
    kill -TERM "$login_pid" 2>/dev/null || true
    wait "$login_pid" 2>/dev/null || true
  fi
  if [[ -n "$login_pgid" ]]; then
    kill -KILL -- "-$login_pgid" 2>/dev/null || true
  fi
  login_pid=""
  login_pgid=""
}

cleanup() {
  local exit_status=$?
  trap - EXIT
  stop_login
  if [[ -n "${work_dir:-}" && -d "$work_dir" ]]; then
    timeout 30 env -u TC_PRIVATE_KEY -u CONNECTOR_CREDENTIAL_MASTER "${tc_cmd[@]}" --no-diagnostic-logs --profile "$profile" auth logout \
      < /dev/null > /dev/null 2>&1 || true
    rm -rf "$work_dir"
  fi
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 1. Create the ephemeral key-only profile in the ephemeral TC_HOME.
env -u TC_PRIVATE_KEY -u CONNECTOR_CREDENTIAL_MASTER "${tc_cmd[@]}" --no-diagnostic-logs init --name "$profile" --key-only --json \
  < /dev/null > "$work_dir/init.out" 2> "$work_dir/init.err"
if [[ $? -ne 0 ]]; then
  echo "status=init_failed"
  exit 1
fi

# 2. Write and verify the single-name manifest before starting sign-in.
manifest_path="$work_dir/manifest.json"
node - "$manifest_path" "$secret_name" <<'NODE'
const fs = require("node:fs");
const [manifestPath, secretName] = process.argv.slice(2);
const expected = {
  manifest_version: 1,
  app_id: "xyz.tinycloud.tinychat-connector-master-backup",
  name: `One-off backup of ${secretName}`,
  space: "secrets",
  permissions: [
    {
      service: "tinycloud.kv",
      path: `vault/secrets/${secretName}`,
      actions: ["get", "put"],
      skipPrefix: true,
    },
    {
      service: "tinycloud.capabilities",
      path: "",
      actions: ["read"],
      skipPrefix: true,
    },
  ],
};
fs.writeFileSync(manifestPath, JSON.stringify(expected, null, 2) + "\n", { mode: 0o600 });
const loaded = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (JSON.stringify(loaded) !== JSON.stringify(expected)) {
  process.exit(1);
}
NODE
if [[ $? -ne 0 ]]; then
  echo "status=manifest_mismatch"
  exit 1
fi

# 3. Start one-tap OpenKey auth login in its own process group, emit the one approval URL, and wait for approval.
start_login() {
  if ! command -v setsid >/dev/null 2>&1; then
    echo "status=setsid_missing"
    exit 1
  fi
  : > "$work_dir/login.out"
  : > "$work_dir/login.err"
  : > "$work_dir/login.rc"
  setsid bash -c '
    rc_file="$1"; out_file="$2"; err_file="$3"; shift 3
    env -u TC_PRIVATE_KEY -u CONNECTOR_CREDENTIAL_MASTER "$@" < /dev/null > "$out_file" 2> "$err_file"
    printf "%s\n" "$?" > "$rc_file"
  ' _ "$work_dir/login.rc" "$work_dir/login.out" "$work_dir/login.err" \
    "${tc_cmd[@]}" --no-diagnostic-logs --profile "$profile" auth login \
      --method openkey \
      --manifest "$manifest_path" \
      --owner "$owner_did" \
      --expiry 1h \
      --no-popup \
      --json \
    < /dev/null > /dev/null 2>&1 &
  login_pid=$!
  login_pgid="$login_pid"
}

extract_approval_link() {
  node - "$work_dir/login.out" "$work_dir/login.err" <<'NODE'
const fs = require("node:fs");
const [outPath, errPath] = process.argv.slice(2);
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const err = read(errPath);
const out = read(outPath);
const links = new Set();
const lines = err.split("\n");
// Only complete (newline-terminated) lines count.
for (let i = 0; i < lines.length - 1; i++) {
  const trimmed = lines[i].trim();
  if (/^https:\/\/\S+$/.test(trimmed)) links.add(trimmed);
}
try {
  const parsed = JSON.parse(out || "{}");
  if (parsed && typeof parsed === "object" && parsed.pending && typeof parsed.pending.approvalUrl === "string") {
    links.add(parsed.pending.approvalUrl.trim());
  }
} catch {}
if (links.size === 0) {
  process.stdout.write("NONE\n");
  process.exit(0);
}
if (links.size > 1) {
  process.stdout.write("INVALID\n");
  process.exit(0);
}
const [url] = [...links];
if (!/^https:\/\/openkey\.so\/a\/[A-Za-z0-9_-]+#\S+$/.test(url)) {
  process.stdout.write("INVALID\n");
  process.exit(0);
}
process.stdout.write(`OK ${url}\n`);
NODE
}

classify_login_exit() {
  local rc="$1"
  node - "$rc" "$work_dir/login.out" "$work_dir/login.err" <<'NODE'
const fs = require("node:fs");
const [rc, outPath, errPath] = process.argv.slice(2);
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const outText = read(outPath);
const errText = read(errPath);
let out = {};
try { out = JSON.parse(outText || "{}"); } catch {}
if (!out || typeof out !== "object") out = {};

let errorCode = "";
for (let i = 0; i < errText.length; i++) {
  if (errText[i] !== "{") continue;
  for (let end = errText.length; end > i; end--) {
    if (errText[end - 1] !== "}") continue;
    try {
      const parsed = JSON.parse(errText.slice(i, end));
      if (parsed && typeof parsed === "object" && parsed.error && typeof parsed.error.code === "string") {
        errorCode = parsed.error.code;
        i = end - 1;
        break;
      }
    } catch {}
  }
}

if (rc === "0" && out.authenticated === true) {
  if (Array.isArray(out.declined) && out.declined.length > 0) {
    process.stdout.write("DECLINED\n");
    process.exit(0);
  }
  const perms = Array.isArray(out.permissions) ? out.permissions : [];
  const hasDecrypt = perms.some((p) =>
    p &&
    typeof p === "object" &&
    (p.service === "tinycloud.encryption" || p.service === "encryption") &&
    Array.isArray(p.actions) &&
    p.actions.some((a) => a === "tinycloud.encryption/decrypt" || a === "decrypt")
  );
  process.stdout.write(hasDecrypt ? "SIGNED_IN_WITH_DECRYPT\n" : "SIGNED_IN_NO_DECRYPT\n");
  process.exit(0);
}
if (rc === "8") {
  const hasPendingUrl = Boolean(out.pending && typeof out.pending.approvalUrl === "string" && out.pending.approvalUrl.trim());
  process.stdout.write(hasPendingUrl ? "PENDING_LINK\n" : "PENDING_UNAVAILABLE\n");
  process.exit(0);
}
if (rc === "3") {
  process.stdout.write("EXPIRED\n");
  process.exit(0);
}
if (rc === "5") {
  process.stdout.write("REFUSED\n");
  process.exit(0);
}
const safeCode = /^[A-Z0-9_]{1,64}$/.test(errorCode) ? errorCode : "";
process.stdout.write(safeCode ? `FAILED ${safeCode}\n` : "FAILED\n");
NODE
}

deadline="$(( $(date +%s) + approval_timeout_seconds ))"
printed_url=""
unavailable_retries=0
has_decrypt=0

start_login

while true; do
  link_state="$(extract_approval_link)"
  if [[ "$link_state" == "INVALID" ]]; then
    stop_login
    echo "status=approval_link_refused"
    exit 1
  elif [[ "$link_state" == OK\ * ]]; then
    approval_url="${link_state#OK }"
    if [[ "$printed_url" != "$approval_url" ]]; then
      echo "status=approval_required"
      printf '%s\n' "$approval_url"
      printed_url="$approval_url"
    fi
  fi

  if [[ -s "$work_dir/login.rc" ]] || ! kill -0 "$login_pid" 2>/dev/null; then
    wait "$login_pid" 2>/dev/null || true
    login_pid=""
    login_pgid=""
    # Re-check for any approval link flushed just before exit (e.g. exit 8 with pending.approvalUrl).
    link_state="$(extract_approval_link)"
    if [[ "$link_state" == "INVALID" ]]; then
      echo "status=approval_link_refused"
      exit 1
    elif [[ "$link_state" == OK\ * ]]; then
      approval_url="${link_state#OK }"
      if [[ "$printed_url" != "$approval_url" ]]; then
        echo "status=approval_required"
        printf '%s\n' "$approval_url"
        printed_url="$approval_url"
      fi
    fi

    rc="$(tr -d '[:space:]' < "$work_dir/login.rc" 2>/dev/null || true)"
    [[ -n "$rc" ]] || rc="1"
    outcome="$(classify_login_exit "$rc")"
    case "$outcome" in
      SIGNED_IN_WITH_DECRYPT)
        has_decrypt=1
        break
        ;;
      SIGNED_IN_NO_DECRYPT)
        has_decrypt=0
        break
        ;;
      DECLINED)
        echo "status=permission_declined"
        exit 1
        ;;
      PENDING_LINK)
        unavailable_retries=0
        if [[ "$(date +%s)" -ge "$deadline" ]]; then
          echo "status=approval_timeout"
          exit 1
        fi
        sleep "$poll_sleep_seconds"
        start_login
        continue
        ;;
      PENDING_UNAVAILABLE)
        unavailable_retries=$((unavailable_retries + 1))
        if [[ "$unavailable_retries" -ge 3 ]]; then
          echo "status=login_unavailable"
          exit 1
        fi
        if [[ "$(date +%s)" -ge "$deadline" ]]; then
          echo "status=approval_timeout"
          exit 1
        fi
        sleep "$poll_sleep_seconds"
        start_login
        continue
        ;;
      EXPIRED)
        echo "status=approval_expired"
        exit 1
        ;;
      REFUSED)
        echo "status=approval_refused"
        exit 1
        ;;
      FAILED\ *)
        echo "status=login_failed code=${outcome#FAILED }"
        exit 1
        ;;
      *)
        echo "status=login_failed"
        exit 1
        ;;
    esac
  fi

  if [[ "$(date +%s)" -ge "$deadline" ]]; then
    stop_login
    echo "status=approval_timeout"
    exit 1
  fi
  sleep "$poll_sleep_seconds"
done

# 4. After approval and before any write, verify whoami ownerDid == OWNER_DID (exact chain ID, case-insensitive address).
env -u TC_PRIVATE_KEY -u CONNECTOR_CREDENTIAL_MASTER "${tc_cmd[@]}" --no-diagnostic-logs --profile "$profile" auth whoami --json \
  < /dev/null > "$work_dir/whoami.out" 2> "$work_dir/whoami.err"
if [[ $? -ne 0 ]]; then
  echo "status=owner_check_failed"
  exit 1
fi

owner_check="$(
  node - "$work_dir/whoami.out" "$owner_did" <<'NODE'
const fs = require("node:fs");
const [whoamiPath, wantRaw] = process.argv.slice(2);
const pkhRe = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/;
const norm = (did) => {
  const base = String(did || "").split("#")[0];
  const m = pkhRe.exec(base);
  return m ? `did:pkh:eip155:${m[1]}:${m[2].toLowerCase()}` : "";
};
let data;
try {
  data = JSON.parse(fs.readFileSync(whoamiPath, "utf8"));
} catch {
  process.stdout.write("INVALID\n");
  process.exit(0);
}
if (!data || typeof data !== "object" || data.authenticated === false) {
  process.stdout.write("UNAUTHENTICATED\n");
  process.exit(0);
}
const have = norm(data.ownerDid);
const want = norm(wantRaw);
if (!have || !want || have !== want) {
  process.stdout.write("MISMATCH\n");
  process.exit(0);
}
process.stdout.write("MATCH\n");
NODE
)"

if [[ "$owner_check" != "MATCH" ]]; then
  echo "status=owner_mismatch"
  exit 1
fi

# 5. Add-only existence check before writing: uses tinycloud.kv/get only, never lists other secrets and never decrypts.
env -u TC_PRIVATE_KEY -u CONNECTOR_CREDENTIAL_MASTER "${tc_cmd[@]}" --no-diagnostic-logs --profile "$profile" secrets wait "$secret_name" \
  --timeout 0 --owner "$owner_did" --json \
  < /dev/null > "$work_dir/exists.out" 2> "$work_dir/exists.err"
exists_rc=$?

exists_state="$(
  node - "$exists_rc" "$work_dir/exists.out" "$secret_name" <<'NODE'
const fs = require("node:fs");
const [rc, outPath, name] = process.argv.slice(2);
let out = {};
try { out = JSON.parse(fs.readFileSync(outPath, "utf8") || "{}"); } catch {}
if (!out || typeof out !== "object") out = {};
const hasName = (arr) => Array.isArray(arr) && arr.includes(name);
if (rc === "0" && out.status === "ready" && (hasName(out.names) || hasName(out.present))) {
  process.stdout.write("PRESENT\n");
} else if (rc === "8" && out.status === "pending" && hasName(out.pending) && !hasName(out.present)) {
  process.stdout.write("ABSENT\n");
} else {
  process.stdout.write("ERROR\n");
}
NODE
)"

verify_readback() {
  local stored_sha256 get_rc
  stored_sha256="$(
    set -o pipefail
    env -u TC_PRIVATE_KEY -u CONNECTOR_CREDENTIAL_MASTER "${tc_cmd[@]}" --no-diagnostic-logs --profile "$profile" secrets get "$secret_name" --raw \
      < /dev/null 2> "$work_dir/get.err" | sha256sum | awk '{print $1}'
  )"
  get_rc=$?
  if [[ "$get_rc" -eq 0 && "$stored_sha256" =~ ^[0-9a-f]{64}$ && "$stored_sha256" == "$source_sha256" ]]; then
    echo "secret=${secret_name} sha256_prefix=${source_prefix} match=yes"
    return 0
  fi
  echo "secret=${secret_name} sha256_prefix=${source_prefix} match=no"
  return 1
}

if [[ "$exists_state" == "PRESENT" ]]; then
  echo "status=already_present"
  if [[ "$has_decrypt" -eq 1 ]]; then
    verify_readback
    exit $?
  fi
  echo "secret=${secret_name} sha256_prefix=${source_prefix} match=unverified"
  exit 1
elif [[ "$exists_state" != "ABSENT" ]]; then
  echo "status=existence_check_failed"
  exit 1
fi

# 6. Write the secret via stdin only (never argv, never a file, never exported env).
printf '%s' "$secret_value" \
  | env -u TC_PRIVATE_KEY -u CONNECTOR_CREDENTIAL_MASTER "${tc_cmd[@]}" --no-diagnostic-logs --profile "$profile" secrets put "$secret_name" --stdin \
    > "$work_dir/put.out" 2> "$work_dir/put.err"
if [[ $? -ne 0 ]]; then
  echo "status=write_failed"
  exit 1
fi

# 7. Verify read-back only when decrypt is granted; otherwise report match=unverified with the 8-hex source prefix.
if [[ "$has_decrypt" -eq 1 ]]; then
  verify_readback
  exit $?
fi

echo "secret=${secret_name} sha256_prefix=${source_prefix} match=unverified"
exit 0
