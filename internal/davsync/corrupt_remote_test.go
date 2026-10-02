package davsync

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/backup"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/settings"
)

// A server whose file a relay cut short used to stop every sync after: the
// body reads back as no backup, and this computer's own setup is fine, so
// there was no way to push over the unreadable file. Now a sync that has a
// trustworthy copy of the version that broke merges over it and writes the
// result back — the way any sync would — so another computer's newer setup
// the damaged write swallowed is not lost. Three cases the rebuild must
// never get wrong are pinned here: a fresh computer that never synced, an
// out-of-date computer whose copy isn't the one that broke, and a server
// that answers with a page instead of a backup at all.
const backupFile = "/dav/magpie/magpie.magpie-backup"

func cut(fake *fakeDAV, file string, keep int) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.n++
	fake.files[file] = append([]byte(nil), fake.files[file][:keep]...)
	fake.etags[file] = `"corrupt"`
}

func onServer(fake *fakeDAV, file string) []byte {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]byte(nil), fake.files[file]...)
}

// The damaged file is a prefix of the last good copy this computer read, so
// it rebuilds: the server ends up whole, and the damaged body is kept aside.
func TestSyncRebuildsFromCachedCopy(t *testing.T) {
	fake := &fakeDAV{files: map[string][]byte{}, etags: map[string]string{}, dirs: map[string]bool{"/dav": true}}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	ctx := context.Background()
	cfg := Config{URL: srv.URL + "/dav/", User: "me", Password: "pw", Passphrase: "horse", Keys: true, Agents: true}

	a := newComputer(t)
	a.use(t)
	provider.Save(provider.Provider{ID: "deepseek", Name: "DeepSeek", Chat: "https://api.deepseek.com/v1", Key: "k1"})
	settings.Save(settings.Settings{Theme: "dark"})
	if err := Configure(cfg); err != nil {
		t.Fatal(err)
	}
	if err := Now(ctx); err != nil {
		t.Fatal(err)
	}
	if len(onServer(fake, backupFile)) == 0 {
		t.Fatal("first sync wrote nothing")
	}
	cut(fake, backupFile, len(onServer(fake, backupFile))/2)

	if err := Now(ctx); err != nil {
		t.Fatalf("a damaged file stopped the sync: %v", err)
	}
	if _, err := backup.Open(onServer(fake, backupFile), "horse"); err != nil {
		t.Fatalf("the server file wasn't rebuilt whole: %v", err)
	}
	if v := Status(); v.Error != "" {
		t.Fatalf("the rebuild left an error: %q", v.Error)
	}
	kept, _ := filepath.Glob(filepath.Join(settings.Dir(), "sync", "*-server-damaged"+backup.Ext))
	if len(kept) != 1 {
		t.Fatalf("the damaged body wasn't kept aside: %v", kept)
	}
}

// A computer that has never synced (st.Local == nil) has no last-good copy
// and no right to rebuild a file it never saw: its own (empty) setup must
// not go up over the damaged one, which would wipe another computer's data.
func TestSyncFreshComputerDoesNotRebuild(t *testing.T) {
	fake := &fakeDAV{files: map[string][]byte{}, etags: map[string]string{}, dirs: map[string]bool{"/dav": true}}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	ctx := context.Background()
	cfg := Config{URL: srv.URL + "/dav/", User: "me", Password: "pw", Passphrase: "horse", Keys: true, Agents: true}

	// A sets up and syncs, then the file is damaged.
	a := newComputer(t)
	a.use(t)
	provider.Save(provider.Provider{ID: "deepseek", Name: "DeepSeek", Chat: "https://api.deepseek.com/v1", Key: "k1"})
	if err := Configure(cfg); err != nil {
		t.Fatal(err)
	}
	if err := Now(ctx); err != nil {
		t.Fatal(err)
	}
	before := onServer(fake, backupFile)
	cut(fake, backupFile, len(before)/2)

	// B joins fresh: it has never synced, so it must not rebuild from its
	// own empty setup.
	b := newComputer(t)
	b.use(t)
	if err := Configure(cfg); err != nil {
		t.Fatal(err)
	}
	if err := Now(ctx); err == nil {
		t.Fatal("a fresh computer rebuilt the damaged file from its empty setup")
	}
	if got := onServer(fake, backupFile); string(got) != string(before[:len(before)/2]) {
		t.Fatal("the fresh computer pushed over the server file anyway")
	}
}

// An out-of-date computer must not rebuild either: its cached copy is an
// older version, not the one the damage replaced, so the damaged body isn't
// a prefix of it. Rebuilding from it would drop a newer computer's part.
func TestSyncOutOfDateComputerDoesNotRebuild(t *testing.T) {
	fake := &fakeDAV{files: map[string][]byte{}, etags: map[string]string{}, dirs: map[string]bool{"/dav": true}}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	ctx := context.Background()
	cfg := Config{URL: srv.URL + "/dav/", User: "me", Password: "pw", Passphrase: "horse", Keys: true, Agents: true}

	a := newComputer(t)
	a.use(t)
	provider.Save(provider.Provider{ID: "deepseek", Name: "DeepSeek", Chat: "https://api.deepseek.com/v1", Key: "k1"})
	if err := Configure(cfg); err != nil {
		t.Fatal(err)
	}
	if err := Now(ctx); err != nil {
		t.Fatal(err)
	}
	// B joins, takes A's setup, adds kimi, and syncs: the server now has
	// both, and A's cached copy (deepseek only) is behind it.
	b := newComputer(t)
	b.use(t)
	if err := Configure(cfg); err != nil {
		t.Fatal(err)
	}
	if err := Now(ctx); err != nil {
		t.Fatal(err)
	}
	provider.Save(provider.Provider{ID: "kimi", Name: "Kimi", Chat: "https://api.moonshot.cn/v1", Key: "k2"})
	if err := Now(ctx); err != nil {
		t.Fatal(err)
	}
	// the server's file — B's, with kimi — is damaged.
	withKimi := onServer(fake, backupFile)
	cut(fake, backupFile, len(withKimi)/2)

	// A, out of date, syncs: it must not rebuild from its copy without kimi.
	a.use(t)
	if err := Now(ctx); err == nil {
		t.Fatal("an out-of-date computer rebuilt the damaged file")
	}
	// B, which saw the version that broke, rebuilds it whole with kimi.
	b.use(t)
	if err := Now(ctx); err != nil {
		t.Fatalf("the computer that saw the good version should rebuild: %v", err)
	}
	rebuilt, err := backup.Open(onServer(fake, backupFile), "horse")
	if err != nil {
		t.Fatalf("rebuilt file doesn't open: %v", err)
	}
	var hasKimi bool
	for _, p := range rebuilt.Providers {
		if p.ID == "kimi" {
			hasKimi = true
		}
	}
	if !hasKimi {
		t.Fatalf("kimi was lost across the rebuild: %+v", rebuilt.Providers)
	}
}

// A server that answers with a page — a captive portal, an auth proxy — is
// not damage to rebuild over: the body isn't backup-shaped at all, so the
// sync must report it, not push this computer's setup and overwrite a good
// file the page merely stood in front of.
func TestSyncPageIsNotDamage(t *testing.T) {
	fake := &fakeDAV{files: map[string][]byte{}, etags: map[string]string{}, dirs: map[string]bool{"/dav": true}}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	ctx := context.Background()
	cfg := Config{URL: srv.URL + "/dav/", User: "me", Password: "pw", Passphrase: "horse", Keys: true, Agents: true}
	a := newComputer(t)
	a.use(t)
	provider.Save(provider.Provider{ID: "deepseek", Name: "DeepSeek", Chat: "https://api.deepseek.com/v1", Key: "k1"})
	if err := Configure(cfg); err != nil {
		t.Fatal(err)
	}
	if err := Now(ctx); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	fake.n++
	fake.files[backupFile] = []byte("<html>please sign in</html>")
	fake.etags[backupFile] = `"page"`
	fake.mu.Unlock()

	puts := fake.puts
	if err := Now(ctx); err == nil || strings.Contains(err.Error(), "rebuilt") {
		t.Fatalf("a page should be reported, not rebuilt: %v", err)
	}
	if fake.puts != puts {
		t.Fatal("a page was treated as damage and pushed over")
	}
}
