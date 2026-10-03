package update

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// StaleCLI tells a copied-file `magpie` command — one that won't follow a
// GUI app update, the stale build behind #531's wedged sync — from the
// installer's link, which will. It's a plain Lstat: what the command is
// says whether it follows the app, so it never runs the old binary to ask
// its version. The bin dir is pointed at a temp dir through MAGPIE_BIN_DIR,
// the same one install.sh honors, so the test needs no real $HOME; only the
// Mac has the two-places problem, so it skips elsewhere.
func TestStaleCLI(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("only the Mac keeps the command apart from the app")
	}
	bin := t.TempDir()
	t.Setenv("MAGPIE_BIN_DIR", bin)
	cli := filepath.Join(bin, "magpie")

	t.Run("a copied file is stale", func(t *testing.T) {
		os.WriteFile(cli, []byte("a build from an old installer"), 0o755)
		if got := StaleCLI(); got != cli {
			t.Errorf("StaleCLI = %q, want %q: a copy won't follow the app", got, cli)
		}
	})

	t.Run("the installer's link is not", func(t *testing.T) {
		os.Remove(cli)
		os.Symlink("/Applications/magpie.app/Contents/MacOS/magpie", cli)
		if got := StaleCLI(); got != "" {
			t.Errorf("StaleCLI = %q, want empty: a link already follows the app", got)
		}
	})

	t.Run("no command is not", func(t *testing.T) {
		os.Remove(cli)
		if got := StaleCLI(); got != "" {
			t.Errorf("StaleCLI = %q, want empty: nothing installed, nothing to say", got)
		}
	})
}
