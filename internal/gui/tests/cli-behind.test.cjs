// Run with Node's test runner and Playwright on the module path; see README.md.
// A machine whose `magpie` command is a copied file (an older installer, a
// hand cp) keeps running that build after a GUI update moves the app on —
// the stale command that wedged a WebDAV sync before #531's check. magpie
// doesn't rewrite the user's PATH itself; it says so once, in the window's
// status line, when /api/state reports cliBehind. The panel is too small
// for advice, so it stays out of it. English and Chinese; no backend, the
// API is faked here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");

const W = {
  en: (p) => `The \`magpie\` command at ${p} is a copy`,
  zh: (p) => `终端里的 \`magpie\` 命令（${p}）是一份拷贝`,
};

function server(lang, behind) {
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") {
      const s = { agents: [], profiles: [], settings: { lang, theme: "light" } };
      if (behind) s.cliBehind = "~/.local/bin/magpie";
      return json(s);
    }
    if (url.pathname === "/api/usage/quotas") return json([]);
    if (url.pathname === "/api/groups") return json({ groups: [] });
    if (url.pathname === "/api/update" || url.pathname === "/api/drift") return json({});
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    test(`${engine} ${lang}: a command left behind is said once, in the window`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      const page = await (await browser.newContext({ viewport: { width: 900, height: 700 }, reducedMotion: "reduce" })).newPage();
      t.after(async () => { await browser.close(); });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", server(lang, true));
      await page.goto("http://magpie.test/");
      const status = page.locator("#status");
      await status.waitFor();
      const text = await status.textContent();
      assert.match(text, new RegExp(W[lang]("~/.local/bin/magpie").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the window says the command is a copy");
      // the whole advice is in the tooltip too, and it's a warning
      assert.match(await status.getAttribute("class"), /warn/);
      // the panel, too small for advice, says nothing
      const panel = await (await browser.newContext({ viewport: { width: 380, height: 600 }, reducedMotion: "reduce" })).newPage();
      panel.setDefaultTimeout(5000);
      panel.on("pageerror", (e) => errors.push(e.message));
      await panel.route("**/*", server(lang, true));
      await panel.goto("http://magpie.test/?mode=panel");
      await panel.locator("#view-agents, #nav, body").first().waitFor();
      await panel.waitForTimeout(500);
      assert.equal((await panel.locator("#status").textContent()).trim(), "", "the panel stays quiet");
      // and no advice when the command is the link (no cliBehind): quiet
      const ok = await (await browser.newContext({ viewport: { width: 900, height: 700 }, reducedMotion: "reduce" })).newPage();
      ok.setDefaultTimeout(5000);
      ok.on("pageerror", (e) => errors.push(e.message));
      await ok.route("**/*", server(lang, false));
      await ok.goto("http://magpie.test/");
      await ok.waitForTimeout(500);
      assert.equal((await ok.locator("#status").textContent()).trim(), "", "a following command is not mentioned");
      const key = "The `magpie` command at {path} is a copy, not the app's link: it won't follow updates. Run the installer, or `magpie update` in a terminal.";
      const missing = await ok.evaluate((k) => [k].filter((x) => !I18N.zh[x]), key);
      assert.deepEqual(missing, [], "the advice has its Chinese");
      assert.deepEqual(errors, []);
    });
  }
}
