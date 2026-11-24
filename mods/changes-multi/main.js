import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, theme, settings } from "herdr";

// Changes for several repos: when the focused folder is inside a git repo it
// shows that repo; otherwise it shows every git repo one level below it.
// One row per repo; clicking a repo expands the diff of all its files.

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie).
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
// The virtual list needs one fixed row height, so every row is ROW tall.
const ROW = 22, INDENT = 14, MAX_FILES = 1000, MAX_LINES_FILE = 1500, MAX_LINES_REPO = 4000, MAX_FRESH_FILES = 40;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

const baseName = (p) => p.split("/").filter(Boolean).pop() || p;
// Diff colors: a green shade for additions, a red one for deletions.
const GREEN = "#3fb950", RED = "#f85149", GREEN_TEXT = "#7ee787", RED_TEXT = "#ffa198", GREEN_BG = "#2ea04333", RED_BG = "#f8514933";
const DIFF_KINDS = ["@", "+", "-", " ", ""];

export default class Changes extends View {
  init(_props, cx) {
    this.repos = []; this.rows = []; this.diffWidth = 300;
    this.expanded = new Set(); this.collapsedFiles = new Set(); this.autoOpened = false;
    this.handle = cx.focus_handle();
    this.refresh(cx);
    cx.timer.every(5000, (cx) => this.refresh(cx));
  }

  // The repo roots to show for a folder: its own repo, else repos one level below.
  async findRoots(cwd, on) {
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
    if (top.code === 0) return { roots: [top.stdout.trim()], single: true };
    const found = await exec("find", [cwd, "-mindepth", "2", "-maxdepth", "2", "-name", ".git"], { cwd, on });
    const roots = found.stdout.split("\n").filter(Boolean).map((p) => p.slice(0, -"/.git".length)).sort();
    return { roots, single: false };
  }

  async loadRepo(root, on) {
    const repo = { root, name: baseName(root), files: [], add: 0, del: 0, limited: false, hasHead: false, error: null };
    try {
      const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
      const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
      if (status.code !== 0) throw new Error(status.stderr);
      const head = await git(["rev-parse", "--verify", "HEAD"]);
      repo.hasHead = head.code === 0;
      const stats = {};
      const results = repo.hasHead
        ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
        : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
      for (const result of results) {
        if (result.code !== 0) throw new Error(result.stderr);
        for (const entry of result.stdout.split("\0")) {
          const [a, d, ...parts] = entry.split("\t");
          if (!parts.length) continue;
          const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
          stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
        }
      }
      const entries = status.stdout.split("\0").filter(Boolean);
      repo.limited = entries.length > MAX_FILES;
      for (const entry of entries.slice(0, MAX_FILES)) {
        const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
        const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
        const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
        const stat = stats[path] ?? { add: 0, del: 0 };
        repo.files.push({ path, status: s, fresh, ...stat });
      }
      repo.add = repo.files.reduce((n, f) => n + f.add, 0);
      repo.del = repo.files.reduce((n, f) => n + f.del, 0);
    } catch (e) { repo.error = String(e).slice(0, 300); }
    return repo;
  }

  // The diff of every changed file of one repo, as lines per path.
  async loadDiffs(repo, on) {
    const diffs = {};
    let budget = MAX_LINES_REPO;
    const git = (args) => exec("git", [...READ, ...args], { cwd: repo.root, on });
    if (repo.files.some((f) => !f.fresh)) {
      const r = await git(["diff", ...(repo.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"]);
      if (r.code !== 0) throw new Error(r.stderr);
      for (const section of ("\n" + r.stdout).split("\ndiff --git ").slice(1)) {
        const lines = section.replace(/\n$/, "").split("\n");
        const m = /^a\/.* b\/(.*)$/.exec(lines[0]);
        if (!m) continue;
        const first = lines.findIndex((l) => l.startsWith("@@"));
        const file = repo.files.find((f) => f.path === m[1]);
        const body = first < 0 ? [file?.binary ? "Binary file changed" : "No text diff available"] : lines.slice(first);
        const cut = body.slice(0, Math.min(MAX_LINES_FILE, Math.max(1, budget)));
        budget -= cut.length;
        diffs[m[1]] = cut.map((l) => l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l);
      }
    }
    let fresh = 0;
    for (const f of repo.files) {
      if (diffs[f.path] || !(f.fresh || (!repo.hasHead && f.status === "A"))) continue;
      if (fresh++ >= MAX_FRESH_FILES || budget <= 0) { diffs[f.path] = ["Not previewed (too many new files)"]; continue; }
      const text = await readTextFile(`${repo.root}/${f.path}`, { on }).catch(() => null);
      if (text === null) diffs[f.path] = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) diffs[f.path] = ["Binary file · no text diff"];
      else {
        f.add = countLines(text);
        const body = text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, Math.min(MAX_LINES_FILE, budget));
        budget -= body.length;
        diffs[f.path] = [`@@ -0,0 +1,${f.add} @@`, ...body.map((l) => `+${l.length > 4000 ? l.slice(0, 4000) + "…" : l}`)];
      }
    }
    for (const f of repo.files) if (!diffs[f.path]) diffs[f.path] = ["Not previewed (diff too large)"];
    repo.add = repo.files.reduce((n, f) => n + f.add, 0);
    repo.diffs = diffs;
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.repos = []; this.rows = []; this.expanded = new Set();
      this.collapsedFiles = new Set(); this.autoOpened = false; this.error = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const { roots, single } = await this.findRoots(cwd, on);
        if (key() !== context) return;
        if (!roots.length) { this.repos = []; this.error = "No git repositories here or one level below"; this.buildRows(); return; }
        const fresh = await Promise.all(roots.map((root) => this.loadRepo(root, on)));
        if (key() !== context) return;
        // Scanning subfolders: keep only the repos that have something to show.
        if (!single) {
          const total = fresh.length;
          for (let i = fresh.length - 1; i >= 0; i--) if (!fresh[i].files.length && !fresh[i].error) fresh.splice(i, 1);
          if (!fresh.length) { this.repos = []; this.error = `No uncommitted changes in ${total} git repos`; this.buildRows(); cx.notify(); return; }
        }
        // Changed repos first, then by name.
        fresh.sort((a, b) => (b.files.length > 0) - (a.files.length > 0) || a.name.localeCompare(b.name));
        const old = new Map(this.repos.map((r) => [r.root, r]));
        for (const r of fresh) r.diffs = old.get(r.root)?.diffs;
        if (!this.autoOpened) { this.autoOpened = true; if (single || fresh.length === 1) this.expanded.add(fresh[0].root); }
        this.error = null; this.on = on; this.repos = fresh;
        this.buildRows(); cx.notify();
        for (const r of fresh) {
          if (!this.expanded.has(r.root) || !r.files.length) continue;
          try { await this.loadDiffs(r, on); }
          catch (e) { r.diffs = {}; r.error = `Cannot preview diff: ${String(e).slice(0, 200)}`; }
          if (key() !== context) return;
          this.buildRows(); cx.notify();
        }
      } catch (e) { if (key() === context) { this.error = String(e).slice(0, 300); this.buildRows(); } }
      finally { this.loading = false; cx.notify(); }
    });
  }

  buildRows() {
    const rows = [];
    for (const repo of this.repos) {
      rows.push({ kind: "repo", repo, key: `repo:${repo.root}` });
      if (!this.expanded.has(repo.root)) continue;
      if (repo.error) { rows.push({ kind: "note", text: repo.error, error: true, key: `n:${rows.length}` }); continue; }
      if (!repo.files.length) { rows.push({ kind: "note", text: "No uncommitted changes", key: `n:${rows.length}` }); continue; }
      for (const file of repo.files) {
        const id = `${repo.root}\0${file.path}`, shut = this.collapsedFiles.has(id);
        rows.push({ kind: "file", file, id, shut, key: `file:${id}` });
        if (shut) continue;
        const lines = repo.diffs?.[file.path];
        if (lines) for (const d of diffRows(lines)) rows.push({ ...d, key: `d:${rows.length}` });
        else rows.push({ kind: "note", text: "Loading…", key: `n:${rows.length}` });
      }
      if (repo.limited) rows.push({ kind: "note", text: `Showing the first ${MAX_FILES} changed files`, key: `n:${rows.length}` });
    }
    this.rows = rows;
    this.diffWidth = Math.max(300, ...rows.map((row) => DIFF_KINDS.includes(row.kind) ? (row.text.length + 1) * 7 + 70 : 0));
  }

  toggleRepo(repo, cx) {
    if (this.expanded.has(repo.root)) this.expanded.delete(repo.root); else this.expanded.add(repo.root);
    this.buildRows(); cx.notify();
    if (this.expanded.has(repo.root) && repo.files.length && !repo.diffs) {
      const context = this.context, on = this.on;
      cx.spawn(async (cx) => {
        try { await this.loadDiffs(repo, on); }
        catch (e) { repo.diffs = {}; repo.error = `Cannot preview diff: ${String(e).slice(0, 200)}`; }
        if (key() === context) { this.buildRows(); cx.notify(); }
      });
    }
  }

  // One handler for the whole list: handlers are not allowed inside the row renderer.
  click(key, cx) {
    if (key.startsWith("repo:")) { const repo = this.repos.find((r) => `repo:${r.root}` === key); if (repo) this.toggleRepo(repo, cx); }
    else if (key.startsWith("file:")) this.toggleFile(key.slice(5), cx);
  }

  toggleFile(id, cx) {
    if (this.collapsedFiles.has(id)) this.collapsedFiles.delete(id); else this.collapsedFiles.add(id);
    this.buildRows(); cx.notify();
  }

  renderRow(row, t) {
    if (row.kind === "repo") {
      const r = row.repo, open = this.expanded.has(r.root), clean = !r.files.length && !r.error;
      return h_flex().w_full().h(ROW).flex_none().px(10).gap(8).items_center().cursor_pointer().bg(t.raised)
        .child(div().w(12).text_color(t.dim).child(open ? "▾" : "▸"))
        .child(div().font_semibold().truncate().min_w(0).text_color(clean ? t.dim : t.foreground).child(r.name))
        .child(div().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(r.error ? "error" : clean ? "clean" : `${r.files.length} files`))
        .child(div().flex_1())
        .when(r.add > 0, (e) => e.child(div().text_size(11).text_color(GREEN).child(`+${r.add}`)))
        .when(r.del > 0, (e) => e.child(div().text_size(11).text_color(RED).child(`−${r.del}`)));
    }
    if (row.kind === "file") {
      const f = row.file, parts = f.path.split("/"), name = parts.pop();
      return h_flex().w_full().h(ROW).flex_none().pl(10 + INDENT).pr(10).gap(8).items_center().cursor_pointer()
        .child(div().w(10).text_color(t.dim).text_size(10).child(row.shut ? "▸" : "▾"))
        .child(div().w(14).text_size(11).text_color(f.status === "A" ? GREEN : f.status === "D" || f.status === "U" ? RED : t.blocked).child(f.status))
        .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().min_w(0).truncate().child(name)))
        .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(GREEN).child(`+${f.add}`)))
        .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(RED).child(`−${f.del}`)));
    }
    if (row.kind === "note") return div().w_full().h(ROW).flex_none().pl(10 + INDENT).flex().items_center().text_size(12).text_color(row.error ? t.ansi1 : t.dim).child(row.text);
    const { kind, number, text } = row;
    if (kind === "@") return div().w_full().h(ROW).flex_none().pl(10 + INDENT).pr(12).flex().items_center().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(ROW).flex_none().pl(10 + INDENT).gap(10).items_center()
      .when(kind === "+", (e) => e.bg(GREEN_BG).text_color(GREEN_TEXT)).when(kind === "-", (e) => e.bg(RED_BG).text_color(RED_TEXT))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    const add = this.repos.reduce((n, r) => n + r.add, 0), del = this.repos.reduce((n, r) => n + r.del, 0);
    return v_flex().id("changes-multi").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(this.repos.length > 1 ? `${this.repos.length} repos` : `${this.repos[0]?.files.length ?? 0} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(GREEN).child(`+${add}`)).child(div().text_size(11).text_color(RED).child(`−${del}`)))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-multi-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-multi-list", this.rows.length, ROW, (i) => this.rows[i].key,
            (range) => this.rows.slice(range.start, range.end).map((row) => this.renderRow(row, t))).size_full().on_item_click((key, cx) => this.click(key, cx)))))
        .child(Scrollbar.vertical("changes-multi-list").viewport_from_layout().absolute().inset_0())
        .when(!this.rows.length, (e) => e.child(div().absolute().top(8).px(12).text_size(13).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : "No folder")))));
  }
}
