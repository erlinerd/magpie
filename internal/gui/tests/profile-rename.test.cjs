// Run with Node's test runner and Playwright on the module path; see README.md.
// Renaming a profile from its details: a field prefilled with the name opens,
// Enter renames, Escape cancels; a rejected rename rolls the list back and the
// error shows. The new name comes up at once and the old one is gone (#2721).
// In the window and in the tray panel, in English and Chinese. No backend: the
// API is faked here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const models = ["model-a", "model-b"].map((m) => ({ value: m, label: m }));
const agent = (id, name) => ({ id, name, path: "/test/" + id, fields: [{ key: "model", label: "model", value: "model-a", options: models }] });
const profile = (name) => ({ name, summary: "", agents: [{ id: "codex", name: "Codex", fields: [{ key: "model", label: "model", value: "gpt-5" }] }] });

function server(lang, calls) {
  let profiles = ["home", "work"].map(profile);
  let reject = false;
  return async (route) => {
    const req = route.request(), url = new URL(req.url());
    const state = () => ({ agents: [agent("codex", "Codex")], profiles, settings: { lang, theme: "light" } });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return route.fulfill({ json: state() });
    if (url.pathname === "/api/window/hide") { calls.push("hide"); return route.fulfill({ json: {} }); }
    if (url.pathname.startsWith("/api/profile/")) {
      const action = url.pathname.slice("/api/profile/".length);
      const body = req.postDataJSON();
      calls.push(action + " " + JSON.stringify(body));
      if (action === "delete") profiles = profiles.filter((p) => p.name !== body.name);
      else if (action === "rename") {
        if (reject) return route.fulfill({ status: 400, json: { error: "a profile named \"work\" already exists" } });
        profiles = profiles.map((p) => (p.name === body.name ? { ...p, name: body.to } : p));
      }
      return route.fulfill({ json: { ...state(), changed: 1 } });
    }
    if (url.pathname === "/api/plugins") return route.fulfill({ json: { plugins: [] } });
    if (url.pathname === "/api/usage/quotas") return route.fulfill({ json: [] });
    if (url.pathname === "/api/groups") return route.fulfill({ json: { groups: [] } });
    if (url.pathname === "/api/providers") return route.fulfill({ json: { providers: [], gateway: { running: true } } });
    if (url.pathname === "/api/window/fit") return route.fulfill({ status: 204 });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await route.fulfill({ body: await fs.readFile(file), contentType });
  };
}

const words = {
  en: { rename: "Rename", close: "Close" },
  zh: { rename: "重命名", close: "关闭" },
};

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  test(engine + ": a profile renames from its details", async (t) => {
    assert(["chromium", "webkit"].includes(engine), "BROWSER must be chromium or webkit");
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    const pages = [];
    t.after(async () => {
      if (process.env.ARTIFACT_DIR) {
        await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
        for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-profile-rename-${i}.png`) });
      }
      await browser.close();
    });

    for (const lang of ["en", "zh"]) for (const panel of [false, true]) {
      await t.test(`${lang}, ${panel ? "panel" : "window"}`, async () => {
        const w = words[lang], calls = [], errors = [];
        const page = await (await browser.newContext({ viewport: panel ? { width: 440, height: 420 } : { width: 900, height: 560 } })).newPage();
        pages.push(page);
        page.setDefaultTimeout(5000);
        page.on("pageerror", (e) => errors.push(e.message));
        await page.route("**/*", server(lang, calls));
        await page.goto("http://magpie.test/" + (panel ? "?mode=panel" : ""));
        const chip = (name) => page.locator("#profiles .chip", { hasText: new RegExp("^" + name) });
        await chip("work").waitFor({ state: "attached" });
        const open = page.locator(".profiles.open");
        if (panel) {
          await page.locator("#profBtn").click();
          await open.waitFor();
          await page.waitForTimeout(450);
        }
        const work = chip("work");
        const detail = page.locator(".prof-detail");

        // the rename entry is in the details
        await work.locator("span").first().click();
        await detail.waitFor();
        const renameBtn = detail.locator(".pd-rename");
        assert.equal((await renameBtn.textContent()).trim(), w.rename);

        // Enter renames to the typed name: the new chip shows, the old gone
        await renameBtn.click();
        const input = detail.locator(".pd-rename-input");
        await input.waitFor();
        assert.equal(await input.inputValue(), "work", "prefilled with the current name");
        await input.fill("team");
        await input.press("Enter");
        await page.waitForFunction(() => ![...document.querySelectorAll("#profiles .chip")].some((c) => /^work/.test(c.textContent)));
        await chip("team").waitFor({ state: "attached" });
        assert.deepEqual(calls.filter((c) => c.startsWith("rename")), ['rename ' + JSON.stringify({ name: "work", to: "team" })]);
        calls.length = 0;

        // Escape cancels: the name stays, the field goes
        await chip("team").locator("span").first().click();
        await detail.waitFor();
        await detail.locator(".pd-rename").click();
        const input2 = detail.locator(".pd-rename-input");
        await input2.waitFor();
        await input2.fill("other");
        await input2.press("Escape");
        await page.waitForTimeout(150);
        assert.equal(await detail.locator(".pd-rename-input").count(), 0, "Escape closes the field");
        assert.deepEqual(calls, [], "Escape renames nothing");
        await detail.locator(".pd-close").click();
        await page.waitForTimeout(150);

        // a rejected rename rolls the list back and shows the error
        calls.length = 0;
        // make the next rename reject: point the fake at a taken name
        await page.evaluate(() => {
          window.__rejectRename = true;
        });
        // re-arm the fake by reloading the route's reject flag through a click
        // that hits the rejecting branch: rename "team" onto "home" (taken)
        await chip("team").locator("span").first().click();
        await detail.waitFor();
        await detail.locator(".pd-rename").click();
        const input3 = detail.locator(".pd-rename-input");
        await input3.waitFor();
        // flip the fake to reject for this call
        await page.route("**/api/profile/rename", async (route) => {
          calls.push("rename-rejected");
          await route.fulfill({ status: 400, json: { error: "a profile named \"home\" already exists" } });
        });
        await input3.fill("home");
        await input3.press("Enter");
        await page.waitForFunction(() => document.querySelector("#status").classList.contains("err"));
        await page.waitForTimeout(150);
        await chip("team").waitFor({ state: "attached" });
        assert.deepEqual((await page.locator("#status").textContent()).trim(), 'a profile named "home" already exists');
        assert.deepEqual(calls, ["rename-rejected"]);

        assert.deepEqual(errors, []);
      });
    }
  });
}
