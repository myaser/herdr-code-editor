// Read-only file viewer for a tab: props { file: absolute path, on?: machine }.
// Syntax-highlighted source; Markdown opens rendered, with a Preview/Source switch.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, Editor, EditorState, TextView, InputState, Input } from "gpui-base";
import { props, focused, readTextFile, writeTextFile, exec, appHome, run, shared, setShared, nextCommand, notify, theme, settings } from "herdr";

const LANG = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "javascript", mts: "javascript", cts: "javascript", tsx: "javascript",
  json: "json", jsonc: "json", json5: "json", yaml: "yaml", yml: "yaml", toml: "yaml",
  py: "python", pyi: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "java", kts: "java", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "java", php: "php", lua: "lua", zig: "zig", scala: "scala",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", env: "bash",
  html: "html", htm: "html", svelte: "html", vue: "html", xml: "html", svg: "html", css: "css", scss: "css", sass: "css",
  sql: "sql", md: "markdown", markdown: "markdown", mdx: "markdown", graphql: "graphql", gql: "graphql", proto: "proto",
  tf: "bash", tfvars: "bash", hcl: "bash", cmake: "cmake", ex: "elixir", exs: "elixir", diff: "diff", patch: "diff",
};
const NAMES = { dockerfile: "bash", makefile: "bash", gnumakefile: "bash", ".bashrc": "bash", ".zshrc": "bash", ".profile": "bash", ".env": "bash", cmakelists: "cmake", "go.mod": "go", "go.sum": "go" };

function languageOf(file) {
  const name = file.split(/[\\/]/).pop().toLowerCase();
  if (NAMES[name]) return NAMES[name];
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return LANG[ext] ?? "text";
}

const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// UTF-8 text -> base64 chunks (kept small enough for a command line).
function encodeChunks(text, size = 60000) {
  const bytes = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += b64[(n >> 18) & 63] + b64[(n >> 12) & 63] + (i + 1 < bytes.length ? b64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? b64[n & 63] : "=");
  }
  const chunks = [];
  for (let i = 0; i < out.length; i += size) chunks.push(out.slice(i, i + size));
  return chunks.length ? chunks : [""];
}

// Write text to a file here, or on another machine over herdr-core, only if it still
// matches `expected` (null: a new file). The remote write goes through a temp file.
async function writeAny(path, text, expected, on) {
  if (!on) return writeTextFile(path, text, expected);
  if (expected !== null) {
    const now = await readTextFile(path, { on });
    if (now !== null && now !== expected) throw new Error("File changed on disk (stale snapshot)");
  }
  const script = 'target="$1"; shift; tmp="$target.herdr.$$"; (for c in "$@"; do printf "%s" "$c"; done | base64 -d) > "$tmp" && mv -f "$tmp" "$target"';
  const r = await exec("sh", ["-c", script, "write", path, ...encodeChunks(text)], { on });
  if (r.code !== 0) throw new Error(r.stderr || `Couldn't write the file on ${on}`);
  return null;
}

// The host rasterizes an SVG at its root width/height, so a 24px icon looks blurry when
// enlarged. Give the preview copy a large size, keeping its proportions.
function enlargeSvg(text, target = 1024) {
  const m = /<svg\b[^>]*>/i.exec(text);
  if (!m) return text;
  const attr = (n) => new RegExp(`\\s${n}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(m[0]);
  const num = (a) => (a ? parseFloat(a[2] ?? a[3]) : NaN);
  let vb = attr("viewBox"), vw = NaN, vh = NaN;
  if (vb) [, , vw, vh] = (vb[2] ?? vb[3]).trim().split(/[\s,]+/).map(Number);
  const w = num(attr("width")), h = num(attr("height"));
  let tag = m[0].replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, "");
  if (!(vw > 0 && vh > 0)) {
    if (!(w > 0 && h > 0)) return text;
    vw = w; vh = h;
    tag = tag.replace(/<svg\b/i, `<svg viewBox="0 0 ${w} ${h}"`);
  }
  const W = target, H = Math.max(1, Math.round(target * vh / vw));
  tag = tag.replace(/<svg\b/i, `<svg width="${W}" height="${H}"`);
  return text.slice(0, m.index) + tag + text.slice(m.index + m[0].length);
}

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export default class FileViewer extends View {
  init(_props, cx) {
    const { file, on } = props() ?? {};
    if (!file) { this.error = "No file given"; return; }
    this.on = on ?? null; this.dirty = false; this.file = file; this.lang = languageOf(file); this.markdown = this.lang === "markdown";
    this.svg = /\.svg$/i.test(file); this.image = /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(file); this.hasPreview = this.markdown || this.svg;
    this.wrap = Boolean(shared("file-viewer.wrap")); this.zoom = 1; this.vp = null; this.cached = null;
    this.find = Boolean(props()?.find); this.caseSensitive = false; this.regex = false; this.cur = 0; this.mkey = null; this.hits = [];
    this.scroll = VirtualListScrollHandle.new(); this.jump = false; this.rootFocus = cx.focus_handle();
    this.conflict = null; this.gone = false; this.ltext = null; this.lines = []; this.starts = [];
    this.query = InputState.new({ placeholder: "Find" });
    this.replacement = InputState.new({ placeholder: "Replace with" });
    if (props()?.query) this.query.set_value(String(props().query));
    this.query.on("change", (_e, cx) => { this.cur = 0; this.jump = true; cx.notify(); });
    this.replacement.on("change", (_e, cx) => cx.notify());
    this.preview = this.hasPreview; this.text = null; this.code = null; this.error = null;
    if (this.image) {
      this.code = null; this.text = ""; this.editable = false; this.disk = "";
      this.loadPicture(cx);
    }
    if (!this.image) cx.spawn(async cx => {
      try {
        const text = await readTextFile(file, { on: on ?? undefined });
        if (text === null) this.error = "This file is no longer available";
        else if (text.includes("\0")) this.error = "Binary file · no text preview";
        else {
          // Edits are written back only for whole, local files.
          this.editable = text.length <= 400000;
          this.disk = text;
          this.text = this.editable ? text : text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
          this.code = this.buildEditor(this.text);
          if (this.svg) this.loadPicture(cx);
        }
      } catch { this.error = "Cannot preview this file (binary, too large, or unreadable)"; }
      cx.notify();
    });
    cx.timer.every(600, (cx) => {
      if (this.dirty && this.tab && focused()?.tab !== this.tab) this.save(cx, true);
    });
    cx.timer.every(1500, (cx) => this.checkDisk(cx));
    // ctrl-s (keys.json: "mod:file-viewer") arrives here.
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        const name = String(c?.name ?? c);
        if (name.endsWith("save")) this.save(cx);
        else if (name.endsWith("wrap")) this.toggleWrap(cx);
        else if (name.endsWith("find")) { this.find = true; this.preview = false; cx.notify(); this.query.focus(); }
      }
    });
  }

  buildEditor(value) {
    const t = theme();
    const code = EditorState.new({ language: this.lang, readonly: !this.editable, value, soft_wrap: this.wrap,
      font_family: settings().font_family, font_size: 13,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1,
        constant: t.ansi6, boolean: t.ansi1, variable: t.foreground, operator: t.ansi6, punctuation: t.muted, "string.escape": t.ansi6 } });
    // Autosave when the keyboard leaves the editor or another tab comes up.
    code.on("focus", () => { this.tab = focused()?.tab ?? this.tab; });
    code.on("blur", (_e, cx) => this.save(cx, true));
    code.on("change", (_e, cx) => {
      this.tab ??= focused()?.tab;
      this.text = code.value();
      const dirty = this.text !== this.disk;
      if (dirty !== this.dirty) { this.dirty = dirty; cx.notify(); }
    });
    return code;
  }

  toggleWrap(cx) {
    this.wrap = !this.wrap;
    setShared("file-viewer.wrap", this.wrap);
    if (this.code) { const value = this.code.value(); this.code.release(); this.code = this.buildEditor(value); }
    cx.notify();
  }

  copyText(cx) {
    cx.write_to_clipboard(this.code ? this.code.value() : this.text ?? "");
    notify({ title: "Copied", body: this.file.split("/").pop(), level: "info", timeout: 1200 });
  }

  // Re-read the file. With unsaved edits it offers the choice instead of discarding them.
  refresh(cx) {
    cx.spawn(async cx => {
      try {
        if (this.image || (this.svg && !this.code)) { this.loadPicture(cx); return; }
        const disk = await readTextFile(this.file, { on: this.on ?? undefined });
        if (disk === null) { this.gone = true; cx.notify(); return; }
        if (this.dirty && disk !== this.code.value()) this.conflict = disk;
        else this.adopt(disk, cx);
        if (this.svg) this.loadPicture(cx);
      } catch {}
    });
  }

  // A copy of the picture under the app folder, which is where image() reads from.
  loadPicture(cx) {
    if (this.on) { this.pictureError = "Pictures can't be previewed from another machine."; cx.notify(); return; }
    const safe = this.file.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-100);
    const name = `${safe}-${Date.now()}${this.svg ? ".svg" : ""}`;
    const dir = `${appHome()}/cache/file-viewer`;
    cx.spawn(async cx => {
      try {
        if (this.svg) {
          const source = this.code ? this.code.value() : this.disk;
          const r = await exec("sh", ["-c", 'mkdir -p "$1" && for o in "$1/$2"-*; do rm -f "$o"; done', "prep", dir, safe]);
          if (r.code !== 0) throw new Error(r.stderr);
          await writeTextFile(`${dir}/${name}`, enlargeSvg(source), null);
        } else {
          const r = await exec("sh", ["-c", 'mkdir -p "$1" && cp -f "$2" "$1/$3" && for o in "$1/$4"-*; do [ "$o" = "$1/$3" ] || rm -f "$o"; done', "copy", dir, this.file, name, safe]);
          if (r.code !== 0) throw new Error(r.stderr);
        }
        this.cached = `cache/file-viewer/${name}`; this.pictureError = null;
      } catch (e) { this.pictureError = "Cannot load this picture."; }
      cx.notify();
    });
  }

  setZoom(z, cx) { this.zoom = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], z)); cx.notify(); }
  stepZoom(d, cx) {
    const i = ZOOMS.findIndex(z => z >= this.zoom - 1e-6);
    this.setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + d))], cx);
  }

  // 100% fits the picture in the pane; more scrolls both ways.
  pictureView(t) {
    if (!this.cached) return div().flex_1().p(12).text_color(t.dim).child(this.pictureError || "Loading picture…");
    const vp = this.vp ?? { width: 600, height: 400 }, w = Math.round(vp.width * this.zoom), h = Math.round(vp.height * this.zoom);
    return div().id("picture-box").relative().flex_1().min_h(0).min_w(0).overflow_hidden().bg(this.svg ? "#ffffff" : t.canvas)
      .on_size_change((size, cx) => { if (!this.vp || Math.abs(this.vp.width - size.width) > 1 || Math.abs(this.vp.height - size.height) > 1) { this.vp = size; cx.notify(); } })
      .child(div().id("picture").absolute().inset_0().overflow_scroll()
        .on_scroll_wheel((e, cx) => { if ((e.modifiers?.control || e.modifiers?.platform) && Math.abs(e.delta.y) >= 1) { cx.stop_propagation(); this.stepZoom(e.delta.y > 0 ? -1 : 1, cx); } })
        .child(div().w(w).h(h).flex().items_center().justify_center().child(image(this.cached).w(w).h(h))));
  }

  // The pattern for the current query and options, or null (empty or invalid regex).
  pattern(flags) {
    const q = this.query.value();
    if (!q) return null;
    try { return new RegExp(this.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags + (this.caseSensitive ? "" : "i")); } catch { return null; }
  }

  // Every match in the text, with its line: recomputed only when text, query or options change.
  matches() {
    const q = this.query.value(), key = JSON.stringify([this.text.length, this.dirty, this.disk === this.text, q, this.caseSensitive, this.regex]) + this.text.slice(0, 64) + this.text.slice(-64);
    if (key === this.mkey) return this.hits;
    this.mkey = key; this.hits = [];
    const re = this.pattern("g");
    if (!re) return this.hits;
    const text = this.text, nl = [];
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) nl.push(i);
    let line = 0;
    for (const m of text.matchAll(re)) {
      if (!m[0].length) continue;
      while (line < nl.length && nl[line] < m.index) line++;
      const start = line ? nl[line - 1] + 1 : 0, end = line < nl.length ? nl[line] : text.length;
      this.hits.push({ index: m.index, length: m[0].length, line: line + 1, snippet: text.slice(start, Math.min(end, start + 160)).trim() });
      if (this.hits.length >= 5000) break;
    }
    return this.hits;
  }

  setText(text, cx) {
    this.code.set_value(text);
    this.text = text; this.dirty = text !== this.disk; this.mkey = null;
    cx.notify();
  }

  replaceCurrent(cx) {
    const hit = this.matches()[this.cur];
    if (!hit || !this.editable) return;
    const piece = this.text.slice(hit.index, hit.index + hit.length), re = this.pattern("");
    const rep = this.regex ? piece.replace(re, this.replacement.value()) : this.replacement.value();
    this.setText(this.text.slice(0, hit.index) + rep + this.text.slice(hit.index + hit.length), cx);
    this.cur = Math.min(this.cur, Math.max(0, this.matches().length - 1));
  }

  replaceAll(cx) {
    const re = this.pattern("g");
    if (!re || !this.editable || !this.matches().length) return;
    const by = this.replacement.value();
    this.setText(this.text.replace(re, this.regex ? by : () => by), cx);
    this.cur = 0;
  }

  // Disk changes (an agent edited the file): pick them up, or flag a conflict with unsaved edits.
  checkDisk(cx) {
    if (!this.code || this.saving || this.checking) return;
    this.checking = true;
    cx.spawn(async cx => {
      try {
        const disk = await readTextFile(this.file, { on: this.on ?? undefined });
        if (disk === null) { if (!this.gone) { this.gone = true; cx.notify(); } }
        else {
          if (this.gone) { this.gone = false; cx.notify(); }
          if (disk !== this.disk && !disk.includes("\0") && !this.saving) {
            const mine = this.code.value();
            if (disk === mine) this.disk = disk;                    // our own write, seen early
            else if (!this.dirty) this.adopt(disk, cx);              // nothing of ours to lose
            else if (this.conflict !== disk) { this.conflict = disk; cx.notify(); }
          } else if (this.conflict !== null && disk === this.disk) { this.conflict = null; cx.notify(); }
        }
      } catch {}
      this.checking = false;
    });
  }

  // Show the file's new contents.
  adopt(disk, cx) {
    this.disk = disk;
    this.conflict = null;
    const big = disk.length > 400000;
    const shown = big ? disk.slice(0, 400000) + "\n… (file truncated)" : disk;
    this.editable = this.editable && !big;
    this.code.set_value(shown);
    this.text = shown; this.dirty = false; this.mkey = null;
    cx.notify();
  }

  // Lines of the shown text and where each starts, for the search view.
  lineData() {
    if (this.ltext !== this.text) {
      this.ltext = this.text; this.lines = this.text.split("\n"); this.starts = [];
      let at = 0;
      for (const l of this.lines) { this.starts.push(at); at += l.length + 1; }
    }
    return this;
  }

  // One line of the search view, matches painted, the current one stronger.
  searchRow(i, re, current, t) {
    const line = this.lines[i], start = this.starts[i], parts = [];
    let last = 0;
    if (re && line) {
      re.lastIndex = 0;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        if (!m[0].length) { re.lastIndex++; continue; }
        if (m.index > last) parts.push(div().child(line.slice(last, m.index)));
        parts.push(div().rounded(2).bg(start + m.index === current ? t.accent : t.selected)
          .text_color(start + m.index === current ? t.accent_foreground : t.foreground).child(m[0]));
        last = m.index + m[0].length;
      }
    }
    if (last < line.length) parts.push(div().child(line.slice(last)));
    return h_flex().h(20).flex_none().items_center()
      .child(div().w(56).flex_none().pr(12).text_right().text_size(12).text_color(t.dim).child(String(i + 1)))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().font_family(settings().font_family).text_size(13).children(parts.length ? parts : [div().child(" ")]));
  }

  searchView(t) {
    this.lineData();
    const hits = this.matches(), cur = Math.min(this.cur, Math.max(0, hits.length - 1)), hit = hits[cur], re = this.pattern("g");
    if (this.jump && hit) { this.scroll.scroll_to_item(hit.line - 1, "center"); }
    this.jump = false;
    return v_flex().relative().flex_1().min_h(0).bg(t.background)
      .child(v_virtual_list("find-lines", this.lines.length, 20, (i) => String(i),
        (range) => { const out = []; for (let i = range.start; i < range.end; i++) out.push(this.searchRow(i, re, hit ? hit.index : -1, t)); return out; })
        .track_scroll(this.scroll).size_full())
      .child(Scrollbar.vertical("find-lines").absolute().inset_0());
  }

  // Last chance: the tab or pane is going away with edits not written.
  async close() {
    if (this.cached) exec("sh", ["-c", 'rm -f "$1"', "rm", `${appHome()}/${this.cached}`]).catch(() => null);
    if (!this.editable || !this.dirty || !this.code) return;
    try { await writeAny(this.file, this.code.value(), this.gone ? null : this.disk, this.on); } catch {}
  }

  save(cx, auto = false) {
    if (!this.editable || !this.code || !this.dirty || this.saving) return;
    this.saving = true;
    const text = this.code.value();
    cx.spawn(async cx => {
      try {
        await writeAny(this.file, text, this.gone ? null : this.disk, this.on);
        this.disk = text; this.dirty = this.code.value() !== text;
        if (!auto) notify({ title: "Saved", body: this.file.split("/").pop(), level: "info", timeout: 1500 });
      } catch (e) {
        notify({ title: "Couldn't save", body: String(e?.message ?? e), level: "error" });
      }
      this.saving = false;
      cx.notify();
    });
  }

  render() {
    const t = theme();
    if (!this.code && !this.image) return div().size_full().bg(t.background).p(12).text_color(t.dim).child(this.error || "Loading file…");
    const seg = (id, label, on, set) => div().id(id).px(10).h(22).flex().items_center().rounded(5).text_size(12).cursor_pointer()
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.preview = set; cx.notify(); }).child(label);
    const btn = (id, label, on, click, tip) => div().id(id).min_w(24).px(7).h(24).flex().items_center().justify_center().flex_none().rounded(5).text_size(12).cursor_pointer()
      .bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .when(Boolean(tip), el => el.tooltip(tip)).on_click((_e, cx) => click(cx)).child(label);
    const bar = h_flex().h(34).flex_none().px(10).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(this.dirty ? t.foreground : t.dim).child(`${this.dirty ? "● " : ""}${this.file}`))
      .when(!this.editable, el => el.child(div().text_size(11).text_color(t.dim).child("read-only")))
      .when(this.editable && this.dirty, el => el.child(div().id("v-save").px(10).h(22).flex().items_center().rounded(5).text_size(12).cursor_pointer()
        .bg(t.accent).text_color(t.accent_foreground).hover(s => s.opacity(0.85))
        .on_click((_e, cx) => this.save(cx)).child("Save")))
      .when(!this.image && (!this.hasPreview || !this.preview), el => el.child(div().id("v-find").px(10).h(22).flex().items_center().rounded(5).text_size(12).cursor_pointer()
        .bg(this.find ? t.selected : t.chrome).text_color(this.find ? t.foreground : t.muted).hover(s => s.bg(t.hover))
        .tooltip("Find and replace (ctrl-f)").on_click((_e, cx) => { this.find = !this.find; cx.notify(); if (this.find) this.query.focus(); }).child("Find")))
      .when(this.hasPreview, el => el.child(h_flex().gap(2).child(seg("v-preview", "Preview", this.preview, true)).child(seg("v-source", this.markdown ? "Source" : "Code", !this.preview, false))))
      .when(this.image || (this.svg && this.preview), el => el.child(h_flex().gap(2).items_center()
        .child(btn("z-out", "−", false, cx => this.stepZoom(-1, cx), "Zoom out"))
        .child(btn("z-reset", `${Math.round(this.zoom * 100)}%`, false, cx => this.setZoom(1, cx), "Fit to pane"))
        .child(btn("z-in", "+", false, cx => this.stepZoom(1, cx), "Zoom in"))))
      .when(!this.image, el => el.child(btn("v-wrap", "↩", this.wrap, cx => this.toggleWrap(cx), "Soft wrap (alt-z)")))
      .when(!this.image, el => el.child(btn("v-copy", "⧉", false, cx => this.copyText(cx), "Copy file text")))
      .child(btn("v-refresh", "⟳", false, cx => this.refresh(cx), "Reload from disk"));
    const field = (state) => div().flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(5).bg(t.raised).border_1().border_color(t.border)
      .text_size(12.5).child(Input.new(state).w_full());
    const editing = !this.image && !(this.hasPreview && this.preview);
    const searching = Boolean(this.find && editing && this.query.value() && this.pattern("g"));
    let findPanel = null;
    if (this.find && editing) {
      const hits = this.matches(), n = hits.length, cur = Math.min(this.cur, Math.max(0, n - 1));
      const go = (d, cx) => { if (n) { this.cur = (cur + d + n) % n; this.jump = true; cx.notify(); } };
      const label = !this.query.value() ? "" : n ? `${cur + 1} of ${n}${n >= 5000 ? "+" : ""}` : "No results";
      findPanel = v_flex().flex_none().gap(6).p(8).bg(t.chrome).border_b(1).border_color(t.border)
        .child(h_flex().gap(6).items_center()
          .child(field(this.query))
          .child(div().w(70).flex_none().text_size(11.5).text_color(n || !this.query.value() ? t.dim : t.blocked).child(label))
          .child(btn("f-prev", "↑", false, cx => go(-1, cx), "Previous match"))
          .child(btn("f-next", "↓", false, cx => go(1, cx), "Next match"))
          .child(btn("f-case", "Aa", this.caseSensitive, cx => { this.caseSensitive = !this.caseSensitive; this.cur = 0; this.jump = true; cx.notify(); }, "Match case"))
          .child(btn("f-regex", ".*", this.regex, cx => { this.regex = !this.regex; this.cur = 0; this.jump = true; cx.notify(); }, "Regular expression"))
          .child(btn("f-close", "×", false, cx => { this.find = false; cx.notify(); }, "Close")))
        .when(this.editable, el => el.child(h_flex().gap(6).items_center()
          .child(field(this.replacement))
          .child(btn("f-rep", "Replace", false, cx => this.replaceCurrent(cx), "Replace this match"))
          .child(btn("f-repall", "Replace all", false, cx => this.replaceAll(cx), "Replace every match"))))
        .when(n > 0, el => el.child(v_flex().id("f-results").max_h(150).overflow_y_scrollbar().gap(1)
          .children(hits.slice(0, 200).map((h, i) => h_flex().id(`f-hit-${i}`).h(22).flex_none().px(6).gap(10).items_center().rounded(4).cursor_pointer()
            .bg(i === cur ? t.selected : t.chrome).hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { this.cur = i; this.jump = true; cx.notify(); })
            .child(div().w(52).flex_none().text_size(11).text_color(t.dim).child(`Ln ${h.line}`))
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(h.snippet))))));
    }
    const text = this.text ?? "";
    const lines = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
    const status = h_flex().h(24).flex_none().px(12).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
      .when(!this.image, el => el.child(`${lines.toLocaleString()} line${lines === 1 ? "" : "s"}`).child(`${text.length.toLocaleString()} characters`))
      .child(div().flex_1())
      .when(searching, el => el.child(div().child("search view · Esc to edit")))
      .when(this.dirty, el => el.child(div().text_color(t.blocked).child("unsaved")))
      .child(this.image ? "image" : this.lang);
    const body = this.image ? this.pictureView(t)
      : this.hasPreview && this.preview && !this.markdown ? this.pictureView(t)
      : this.markdown && this.preview
      ? v_flex().id("md-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(28).py(20)
          .child(TextView.markdown("md-view", this.code.value()).selectable(true).text_color(t.foreground))
      : searching ? this.searchView(t)
      : Editor.new(this.code).flex_1().min_h(0);
    const banner = (text, buttons) => h_flex().flex_none().px(12).py(6).gap(10).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(12)
      .child(div().flex_1().min_w(0).truncate().text_color(t.blocked).child(text)).children(buttons);
    const notice = this.conflict !== null
      ? banner("This file changed on disk while you have unsaved edits.", [
          btn("c-reload", "Load disk version", false, cx => this.adopt(this.conflict, cx), "Discard your edits"),
          btn("c-keep", "Keep mine", false, cx => { this.disk = this.conflict; this.conflict = null; cx.notify(); }, "Your next save overwrites the disk version")])
      : this.gone ? banner("This file no longer exists on disk. Saving will recreate it.", []) : null;
    return v_flex().size_full().bg(t.background).text_color(t.foreground)
      .track_focus(this.rootFocus)
      .on_key_down((e, cx) => {
        if (e.keystroke === "escape" && this.find) { this.find = false; cx.notify(); }
      })
      .child(bar).child(notice ?? div()).child(findPanel ?? div()).child(body).child(status);
  }
}
