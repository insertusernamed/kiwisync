#!/usr/bin/env bash
# Installs the KiwiSync plugin into an Obsidian vault on this Linux computer.
# Usage: curl -fsSL <server>/install.sh | bash
#    or: curl -fsSL <server>/install.sh | bash -s -- /path/to/vault
set -euo pipefail

server='@KIWISYNC_URL@'

die() {
  echo "$1" >&2
  exit 1
}

command -v python3 >/dev/null || die "python3 is required."

vault="${1:-}"
if [ -z "$vault" ]; then
  # Obsidian keeps its vault list in a different place for each way it can be installed.
  mapfile -t vaults < <(python3 - <<'PY'
import json, os
home = os.path.expanduser('~')
for config in [
    '.config/obsidian/obsidian.json',
    '.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json',
    'snap/obsidian/current/.config/obsidian/obsidian.json',
]:
    try:
        with open(os.path.join(home, config)) as f:
            for v in json.load(f).get('vaults', {}).values():
                if os.path.isdir(v.get('path', '')):
                    print(v['path'])
    except (OSError, ValueError):
        pass
PY
  )
  case ${#vaults[@]} in
    0) die "No Obsidian vaults found. Open your vault in Obsidian once, or pass its folder: bash -s -- /path/to/vault" ;;
    1) vault="${vaults[0]}" ;;
    *)
      echo "Which vault should KiwiSync sync?"
      for i in "${!vaults[@]}"; do echo "  $((i + 1))) ${vaults[$i]}"; done
      read -rp "Number: " choice </dev/tty
      [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le ${#vaults[@]} ] || die "No vault chosen."
      vault="${vaults[$((choice - 1))]}"
      ;;
  esac
fi
[ -d "$vault" ] || die "$vault is not a folder."

# Obsidian rewrites its plugin list when it quits, which would undo the change below.
if pgrep -x obsidian >/dev/null || pgrep -f 'md.obsidian.Obsidian' >/dev/null; then
  read -rp "Close Obsidian, then press Enter to continue. " _ </dev/tty
fi

plugin="$vault/.obsidian/plugins/kiwisync"
mkdir -p "$plugin"
for file in main.js manifest.json styles.css; do
  curl -fsSL "$server/plugin/$file" -o "$plugin/$file.tmp"
  mv "$plugin/$file.tmp" "$plugin/$file"
done

python3 - "$vault/.obsidian/community-plugins.json" <<'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path) as f:
        enabled = json.load(f)
except (OSError, ValueError):
    enabled = []
if 'kiwisync' not in enabled:
    enabled.append('kiwisync')
with open(path, 'w') as f:
    json.dump(enabled, f, indent=2)
PY

echo
echo "KiwiSync is installed in $vault."
echo "Open Obsidian, then go to Settings, KiwiSync, and choose Connect."
echo "If Obsidian asks whether to trust community plugins, choose to turn them on."
