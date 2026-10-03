package update

import (
	"os"
	"path/filepath"
	"runtime"
)

// StaleCLI is the path of a `magpie` command that is a copied file rather
// than the installer's link into the app, or "" when there's nothing to
// say. install.sh links the command to magpie.app's binary so it follows
// every app update for free; a command that arrived as a copy — an older
// installer, a hand cp — keeps running its own build once the app moves
// on, and a command behind the app is a stale build: one that predates the
// WebDAV short-write check (#531) truncated a remote backup on `magpie
// webdav now`, wedging the sync.
//
// magpie doesn't rewrite that file itself. What the command *is* — a copy,
// not the link — is enough to say it won't follow the app, so this is a
// plain Lstat: no reading the old binary's version, which would run its
// start-up migrations. `magpie update`, an update the user asked for,
// checks this after it installs a new app and tells them the command is
// behind, leaving the fix — `magpie update` again, or a re-run install.sh,
// either of which makes the link — to whoever runs the command. Only on
// the Mac, where the app and the command are two places; on Linux they are
// one file.
func StaleCLI() string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	bin := os.Getenv("MAGPIE_BIN_DIR")
	if bin == "" {
		home := os.Getenv("HOME")
		if home == "" {
			return ""
		}
		bin = filepath.Join(home, ".local", "bin")
	}
	cli := filepath.Join(bin, "magpie")
	st, err := os.Lstat(cli)
	if err != nil || !st.Mode().IsRegular() {
		return "" // absent, the installer's link, or nothing to point at
	}
	return cli
}
