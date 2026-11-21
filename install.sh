#!/bin/sh
# Installs (or updates) Omega from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/philippeZim/Omega/main/install.sh | sh
#
# Linux: puts the AppImage in ~/.local/bin, adds an app-menu entry and an `omega` command.
# macOS: puts Omega.app in /Applications (or ~/Applications) and clears the quarantine flag.
# Uninstall: curl -fsSL https://raw.githubusercontent.com/philippeZim/Omega/main/install.sh | sh -s -- --uninstall
#
# After installing, Omega updates itself, so you only need this once.
set -eu

REPO="philippeZim/Omega"
LATEST="https://github.com/$REPO/releases/latest/download"
RAW="https://raw.githubusercontent.com/$REPO/main"

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then curl -fL --progress-bar -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q --show-progress -O "$2" "$1"
  else die "needs curl or wget"; fi
}

BIN="$HOME/.local/bin"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"

# Quotes a value for a POSIX shell script.
sh_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Quotes a path for the Exec line of a .desktop file.
desktop_quote() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/[\\"`$]/\\\\&/g' -e 's/%/%%/g')"; }

# Is the `omega` at $1 ours? Marked launchers, and the two-line one older versions of this script wrote.
is_our_launcher() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  grep -q 'omega-launcher' "$1" && return 0
  [ "$(wc -l < "$1")" -eq 2 ] && [ "$(head -n 1 "$1")" = '#!/bin/sh' ] && tail -n 1 "$1" | grep -q '^exec .*Omega\.AppImage "\$@"$'
}

# write_launcher <file> <command words, already quoted>. Leaves someone else's `omega` alone.
write_launcher() {
  if { [ -e "$1" ] || [ -L "$1" ]; } && ! is_our_launcher "$1"; then
    say "Note: $1 already exists and isn't from Omega, so it was left alone."
    say "      Omega's Settings > Installations can replace it."
    return 0
  fi
  printf '#!/bin/sh\n# omega-launcher: created by Omega\nexec %s "$@"\n' "$2" > "$1.tmp.$$"
  chmod 755 "$1.tmp.$$"
  mv -f "$1.tmp.$$" "$1"
}

uninstall_linux() {
  rm -f "$BIN/Omega.AppImage" "$APPS/omega.desktop"
  if is_our_launcher "$BIN/omega"; then rm -f "$BIN/omega"; fi
  for s in 128x128 256x256 512x512; do rm -f "$ICONS/$s/apps/omega.png"; done
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" 2>/dev/null || true
  say "Omega removed. Your settings stay in ~/.local/share/io.github.philippezim.omega."
}

has_fuse2() {
  for d in /usr/lib /usr/lib64 /lib /lib64 /usr/lib/x86_64-linux-gnu /lib/x86_64-linux-gnu; do
    ls "$d"/libfuse.so.2* >/dev/null 2>&1 && return 0
  done
  return 1
}

install_linux() {
  [ "$(uname -m)" = "x86_64" ] || die "Omega for Linux is only built for x86_64 so far (this machine: $(uname -m))."

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  say "Looking up the latest version…"
  fetch "$LATEST/latest.json" "$tmp/latest.json" 2>/dev/null
  version=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$tmp/latest.json" | head -n 1)
  [ -n "$version" ] || die "couldn't read the latest version"

  say "Downloading Omega $version…"
  fetch "$LATEST/Omega_${version}_amd64.AppImage" "$tmp/Omega.AppImage"
  mkdir -p "$BIN" "$APPS"
  install -m 755 "$tmp/Omega.AppImage" "$BIN/Omega.AppImage"

  # Without libfuse2 (missing by default on e.g. Ubuntu 24.04) the AppImage can still run by
  # unpacking itself on every start. Slower, so we tell the user how to fix it.
  # NO_CLEANUP: `omega` detaches from the terminal, and the process that exits must not delete
  # what its detached copy runs from.
  run=$(sh_quote "$BIN/Omega.AppImage")
  exec_line=$(desktop_quote "$BIN/Omega.AppImage")
  if ! has_fuse2; then
    run="env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 $run"
    exec_line="env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 $exec_line"
    nofuse=1
  fi
  write_launcher "$BIN/omega" "$run"

  for s in 128x128 256x256 512x512; do mkdir -p "$ICONS/$s/apps"; done
  fetch "$RAW/src-tauri/icons/128x128.png" "$ICONS/128x128/apps/omega.png" 2>/dev/null || true
  fetch "$RAW/src-tauri/icons/128x128@2x.png" "$ICONS/256x256/apps/omega.png" 2>/dev/null || true
  fetch "$RAW/src-tauri/icons/icon.png" "$ICONS/512x512/apps/omega.png" 2>/dev/null || true

  cat > "$APPS/omega.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Omega
GenericName=Editor
Comment=Notes, LaTeX and code in one app
Exec=$exec_line %F
Icon=omega
Terminal=false
Categories=Development;TextEditor;
Keywords=markdown;latex;notes;code;ide;editor;
MimeType=text/markdown;text/x-tex;
StartupWMClass=ide
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$ICONS" 2>/dev/null || true

  say ""
  say "Omega $version is installed. Start it from your app menu, or run: omega ."
  case ":$PATH:" in *":$BIN:"*) ;; *) say "(Add ~/.local/bin to your PATH to use the omega command.)" ;; esac
  if [ "${nofuse:-}" = 1 ]; then
    say ""
    say "Tip: installing libfuse2 makes Omega start faster:"
    say "  Ubuntu/Debian: sudo apt install libfuse2t64   (Ubuntu 22.04: libfuse2)"
    say "  Fedora:        sudo dnf install fuse-libs"
    say "  Arch:          sudo pacman -S fuse2"
  fi
}

install_macos() {
  case "$(uname -m)" in
    arm64) asset="Omega_aarch64.app.tar.gz" ;;
    x86_64) asset="Omega_x64.app.tar.gz" ;;
    *) die "unsupported Mac: $(uname -m)" ;;
  esac
  dest=/Applications
  [ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  say "Downloading Omega…"
  fetch "$LATEST/$asset" "$tmp/omega.tar.gz"
  tar -xzf "$tmp/omega.tar.gz" -C "$tmp"
  rm -rf "$dest/Omega.app"
  mv "$tmp/Omega.app" "$dest/Omega.app"
  # The app isn't notarized yet; without this macOS refuses to open it.
  xattr -cr "$dest/Omega.app" 2>/dev/null || true
  mkdir -p "$BIN"
  for exe in "$dest/Omega.app/Contents/MacOS/"*; do
    [ -x "$exe" ] && write_launcher "$BIN/omega" "$(sh_quote "$exe")" && break
  done
  say ""
  say "Omega is installed in $dest. Open it from Launchpad or Spotlight, or run: omega ."
  case ":$PATH:" in *":$BIN:"*) ;; *) say "(Add ~/.local/bin to your PATH to use the omega command.)" ;; esac
}

uninstall_macos() {
  rm -rf /Applications/Omega.app "$HOME/Applications/Omega.app"
  if is_our_launcher "$BIN/omega"; then rm -f "$BIN/omega"; fi
  say "Omega removed."
}

action=install
[ "${1:-}" = "--uninstall" ] && action=uninstall

case "$(uname -s)" in
  Linux) "${action}_linux" ;;
  Darwin) "${action}_macos" ;;
  *) die "on Windows, download Omega_…_x64-setup.exe from https://github.com/$REPO/releases/latest" ;;
esac
