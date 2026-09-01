const {
	Plugin,
	PluginSettingTab,
	Setting,
	TextFileView,
	MarkdownRenderChild,
	MarkdownView,
	Notice,
	TFile,
	Menu,
	Modal,
} = require("obsidian");

const VIEW_TYPE = "csv-workbench";
const DEFAULT_SETTINGS = {
	dropFolder: "same", // same | attachment | custom
	customFolder: "",
	insertStyle: "embed", // embed | wikilink | markdown
	autoSave: true,
	showRowNumbers: true,
	embedMaxRows: 200,
	reuseExisting: true,
	enableTsv: true,
};

function hasExt(name, exts) {
	const lower = (name || "").toLowerCase();
	return exts.some((e) => lower.endsWith("." + e));
}

function detectDelimiter(text) {
	const first = (text.split(/\r?\n/)[0] || "");
	const counts = {
		",": (first.match(/,/g) || []).length,
		";": (first.match(/;/g) || []).length,
		"\t": (first.match(/\t/g) || []).length,
	};
	let best = ",",
		n = -1;
	for (const [k, v] of Object.entries(counts)) {
		if (v > n) {
			best = k;
			n = v;
		}
	}
	return n > 0 ? best : ",";
}

function parseCsv(text) {
	if (text == null) text = "";
	let bom = false;
	if (text.charCodeAt(0) === 0xfeff) {
		bom = true;
		text = text.slice(1);
	}
	const newline = text.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
	const delimiter = detectDelimiter(text);
	const rows = [];
	let row = [];
	let field = "";
	let i = 0;
	let inQuotes = false;
	while (i < text.length) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += ch;
			i++;
			continue;
		}
		if (ch === '"') {
			inQuotes = true;
			i++;
			continue;
		}
		if (ch === delimiter) {
			row.push(field);
			field = "";
			i++;
			continue;
		}
		if (ch === "\r") {
			i++;
			continue;
		}
		if (ch === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			i++;
			continue;
		}
		field += ch;
		i++;
	}
	if (inQuotes || field.length || row.length) {
		row.push(field);
		rows.push(row);
	}
	if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
		rows.pop();
	}
	const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
	for (const r of rows) {
		while (r.length < width) r.push("");
	}
	if (!rows.length) rows.push([""]);
	return { rows, delimiter, newline, bom, trailingNewline: /\r?\n$/.test(text) };
}

function escapeField(value, delimiter) {
	const s = value == null ? "" : String(value);
	if (s.indexOf('"') !== -1 || s.indexOf("\n") !== -1 || s.indexOf("\r") !== -1 || s.indexOf(delimiter) !== -1) {
		return '"' + s.replace(/"/g, '""') + '"';
	}
	return s;
}

function serializeCsv(rows, meta) {
	const d = meta.delimiter || ",";
	const nl = meta.newline || "\n";
	const lines = rows.map((row) => row.map((cell) => escapeField(cell, d)).join(d));
	let body = lines.join(nl);
	if (meta.trailingNewline && body && !/\r?\n$/.test(body)) body += nl;
	return (meta.bom ? "\uFEFF" : "") + body;
}

function colLetter(n) {
	let s = "";
	let x = n + 1;
	while (x > 0) {
		const m = (x - 1) % 26;
		s = String.fromCharCode(65 + m) + s;
		x = Math.floor((x - 1) / 26);
	}
	return s;
}

async function readDroppedFile(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result || ""));
		reader.onerror = reject;
		reader.readAsText(file, "UTF-8");
	});
}

function csvFilesFromEvent(evt) {
	const list = [];
	const dt = evt.dataTransfer;
	if (!dt) return list;
	if (dt.files && dt.files.length) {
		for (let i = 0; i < dt.files.length; i++) {
			const f = dt.files[i];
			if (hasExt(f.name, ["csv", "tsv"])) list.push(f);
		}
	}
	return list;
}

class CsvGrid {
	constructor(container, options) {
		this.container = container;
		this.options = options || {};
		this.rows = [[""]];
		this.meta = { delimiter: ",", newline: "\n", bom: false, trailingNewline: true };
		this.sel = { r: 0, c: 0 };
		this.editing = false;
		this.dirty = false;
		this.filter = "";
		this.history = [];
		this.historyIndex = -1;
		this.destroyed = false;
		this.popoverEl = null;
		this.popoverMode = null;
		this.LONG_CELL_MIN = 36;
		this.build();
	}

	build() {
		this.root = this.container.createDiv({ cls: "csv-wb" });
		this.toolbar = this.root.createDiv({ cls: "csv-wb-toolbar" });
		this.buildToolbar();
		this.scroll = this.root.createDiv({ cls: "csv-wb-scroll" });
		this.status = this.root.createDiv({ cls: "csv-wb-status" });
		this.bindKeys();
		this.scroll.addEventListener("paste", (e) => {
			if (this.editing) return;
			const text = e.clipboardData && e.clipboardData.getData("text");
			if (text) {
				e.preventDefault();
				this.pasteText(text);
			}
		});
	}

	destroy() {
		this.destroyed = true;
		this.closePopover();
		this.root.detach();
	}

	isLongContent(value) {
		const s = value == null ? "" : String(value);
		return s.length > this.LONG_CELL_MIN || /[\r\n]/.test(s);
	}

	closePopover() {
		if (this._popoverOutside) {
			document.removeEventListener("mousedown", this._popoverOutside);
			this._popoverOutside = null;
		}
		if (this._popoverScroll && this.scroll) {
			this.scroll.removeEventListener("scroll", this._popoverScroll);
			this._popoverScroll = null;
		}
		if (this.popoverEl) {
			this.popoverEl.remove();
			this.popoverEl = null;
		}
		this.popoverMode = null;
	}

	positionPopover(pop, anchor) {
		const margin = 8;
		pop.style.visibility = "hidden";
		pop.style.display = "block";
		const rect = anchor.getBoundingClientRect();
		const pw = pop.offsetWidth;
		const ph = pop.offsetHeight;
		let left = rect.left;
		let top = rect.bottom + 6;
		if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
		if (left < margin) left = margin;
		if (top + ph > window.innerHeight - margin) top = Math.max(margin, rect.top - ph - 6);
		pop.style.left = left + "px";
		pop.style.top = top + "px";
		pop.style.visibility = "visible";
	}

	bindPopoverDismiss(pop, anchor) {
		this._popoverOutside = (e) => {
			if (pop.contains(e.target) || anchor.contains(e.target)) return;
			this.closePopover();
		};
		setTimeout(() => document.addEventListener("mousedown", this._popoverOutside), 0);
		this._popoverScroll = () => this.closePopover();
		this.scroll.addEventListener("scroll", this._popoverScroll, { passive: true });
	}

	showPreviewPopover(anchorTd, r, c) {
		const value = this.rows[r][c] || "";
		if (!this.isLongContent(value)) {
			this.closePopover();
			return;
		}
		if (this.popoverMode === "preview" && this.popoverAnchor === anchorTd) return;
		this.closePopover();
		this.popoverAnchor = anchorTd;
		const pop = document.body.createDiv({ cls: "csv-wb-popover csv-wb-popover-preview" });
		const head = pop.createDiv({ cls: "csv-wb-popover-head" });
		head.setText(`${colLetter(c)}${r + 1} · 完整内容`);
		const body = pop.createDiv({ cls: "csv-wb-popover-body" });
		body.setText(value);
		const foot = pop.createDiv({ cls: "csv-wb-popover-foot" });
		foot.setText("双击单元格可编辑完整内容");
		this.popoverEl = pop;
		this.popoverMode = "preview";
		this.positionPopover(pop, anchorTd);
		this.bindPopoverDismiss(pop, anchorTd);
	}

	startEditPopover(r, c, initial) {
		const td = this.scroll.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
		if (!td) return;
		this.closePopover();
		this.editing = true;
		this.select(r, c);
		const current = this.rows[r][c] || "";
		const pop = document.body.createDiv({ cls: "csv-wb-popover csv-wb-popover-edit" });
		const head = pop.createDiv({ cls: "csv-wb-popover-head" });
		head.setText(`${colLetter(c)}${r + 1} · 编辑`);
		const ta = pop.createEl("textarea", { cls: "csv-wb-popover-textarea" });
		ta.value = initial != null ? current + initial : current;
		const foot = pop.createDiv({ cls: "csv-wb-popover-foot csv-wb-popover-actions" });
		const saveBtn = foot.createEl("button", { cls: "csv-wb-btn csv-wb-popover-save", text: "保存" });
		const cancelBtn = foot.createEl("button", { cls: "csv-wb-btn", text: "取消" });
		foot.createSpan({ cls: "csv-wb-popover-hint", text: "Ctrl/Cmd+Enter 保存 · Esc 取消" });
		this.popoverEl = pop;
		this.popoverMode = "edit";
		this.positionPopover(pop, td);
		ta.focus();
		ta.setSelectionRange(ta.value.length, ta.value.length);
		const commit = () => {
			if (!this.editing || this.popoverMode !== "edit") return;
			this.editing = false;
			this.closePopover();
			this.setCell(r, c, ta.value);
			this.root.focus();
		};
		const cancel = () => {
			this.editing = false;
			this.closePopover();
			this.render();
			this.select(r, c);
			this.root.focus();
		};
		saveBtn.addEventListener("click", (e) => {
			e.preventDefault();
			commit();
		});
		cancelBtn.addEventListener("click", (e) => {
			e.preventDefault();
			cancel();
		});
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				cancel();
			} else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
				e.preventDefault();
				commit();
			}
			e.stopPropagation();
		});
		this._popoverOutside = (e) => {
			if (pop.contains(e.target) || td.contains(e.target)) return;
			commit();
		};
		setTimeout(() => document.addEventListener("mousedown", this._popoverOutside), 0);
		this._popoverScroll = () => {
			if (this.popoverMode === "edit") commit();
			else this.closePopover();
		};
		this.scroll.addEventListener("scroll", this._popoverScroll, { passive: true });
	}

	buildToolbar() {
		const g = (parent) => parent.createDiv({ cls: "csv-wb-toolbar-group" });
		const btn = (parent, text, title, fn) => {
			const b = parent.createEl("button", { cls: "csv-wb-btn", text, attr: { title } });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				fn();
			});
			return b;
		};
		const sep = (parent) => parent.createDiv({ cls: "csv-wb-sep" });

		const fileG = g(this.toolbar);
		this.saveBtn = btn(fileG, "保存", "保存到 CSV 文件 (Ctrl/Cmd+S)", () => this.requestSave(true));
		btn(fileG, "重载", "从磁盘重新读取（任意程序写回后可点这里）", () => this.options.onReload && this.options.onReload());
		sep(this.toolbar);

		const editG = g(this.toolbar);
		btn(editG, "撤销", "Ctrl/Cmd+Z", () => this.undo());
		btn(editG, "重做", "Ctrl/Cmd+Shift+Z", () => this.redo());
		sep(this.toolbar);

		const rowG = g(this.toolbar);
		btn(rowG, "+ 行", "在下方插入行", () => this.insertRow(this.sel.r + 1));
		btn(rowG, "− 行", "删除当前行", () => this.deleteRow(this.sel.r));
		btn(rowG, "+ 列", "在右侧插入列", () => this.insertCol(this.sel.c + 1));
		btn(rowG, "− 列", "删除当前列", () => this.deleteCol(this.sel.c));
		sep(this.toolbar);

		const sortG = g(this.toolbar);
		btn(sortG, "升序", "按当前列升序（表头行不参与）", () => this.sort(this.sel.c, true));
		btn(sortG, "降序", "按当前列降序（表头行不参与）", () => this.sort(this.sel.c, false));
		sep(this.toolbar);

		this.searchEl = this.toolbar.createEl("input", {
			cls: "csv-wb-search",
			attr: { type: "search", placeholder: "筛选…  Ctrl/Cmd+F" },
		});
		this.searchEl.addEventListener("input", () => {
			this.filter = this.searchEl.value;
			this.applyFilter();
		});
		this.metaEl = this.toolbar.createDiv({ cls: "csv-wb-meta" });
	}

	bindKeys() {
		this.root.tabIndex = 0;
		this.root.addEventListener("keydown", (e) => this.onKey(e));
	}

	onKey(e) {
		if (this.editing) {
			if (e.key === "Escape") {
				e.preventDefault();
				if (this.popoverMode === "edit") {
					this.editing = false;
					this.closePopover();
					this.render();
					this.select(this.sel.r, this.sel.c);
					this.root.focus();
				} else {
					this.cancelEdit();
				}
			}
			return;
		}
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.key.toLowerCase() === "s") {
			e.preventDefault();
			this.requestSave(true);
			return;
		}
		if (mod && e.key.toLowerCase() === "z") {
			e.preventDefault();
			if (e.shiftKey) this.redo();
			else this.undo();
			return;
		}
		if (mod && e.key.toLowerCase() === "y") {
			e.preventDefault();
			this.redo();
			return;
		}
		if (mod && e.key.toLowerCase() === "f") {
			e.preventDefault();
			this.searchEl.focus();
			this.searchEl.select();
			return;
		}
		if (mod && e.key.toLowerCase() === "c") {
			e.preventDefault();
			this.copy();
			return;
		}
		if (mod && e.key.toLowerCase() === "x") {
			e.preventDefault();
			this.cut();
			return;
		}
		if (mod && e.key.toLowerCase() === "v") {
			return;
		}
		if (e.key === "Tab") {
			e.preventDefault();
			this.move(0, e.shiftKey ? -1 : 1);
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			if (e.shiftKey) this.move(-1, 0);
			else this.startEdit();
			return;
		}
		if (e.key === "F2") {
			e.preventDefault();
			this.startEdit();
			return;
		}
		if (e.key === "Delete" || e.key === "Backspace") {
			e.preventDefault();
			this.setCell(this.sel.r, this.sel.c, "");
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			this.move(-1, 0);
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			this.move(1, 0);
			return;
		}
		if (e.key === "ArrowLeft") {
			e.preventDefault();
			this.move(0, -1);
			return;
		}
		if (e.key === "ArrowRight") {
			e.preventDefault();
			this.move(0, 1);
			return;
		}
		if (e.key.length === 1 && !mod && !e.altKey) {
			this.startEdit(e.key);
		}
	}

	load(text, pushHistory) {
		const parsed = parseCsv(text || "");
		this.rows = parsed.rows;
		this.meta = {
			delimiter: parsed.delimiter,
			newline: parsed.newline,
			bom: parsed.bom,
			trailingNewline: parsed.trailingNewline,
		};
		this.sel = { r: 0, c: 0 };
		this.editing = false;
		this.dirty = false;
		if (pushHistory !== false) this.resetHistory();
		this.render();
	}

	serialize() {
		return serializeCsv(this.rows, this.meta);
	}

	resetHistory() {
		this.history = [this.serialize()];
		this.historyIndex = 0;
	}

	pushHistory() {
		const snap = this.serialize();
		if (this.history[this.historyIndex] === snap) return;
		this.history = this.history.slice(0, this.historyIndex + 1);
		this.history.push(snap);
		if (this.history.length > 80) this.history.shift();
		this.historyIndex = this.history.length - 1;
	}

	undo() {
		if (this.historyIndex <= 0) return;
		this.historyIndex--;
		this.load(this.history[this.historyIndex], false);
		this.markDirty();
	}

	redo() {
		if (this.historyIndex >= this.history.length - 1) return;
		this.historyIndex++;
		this.load(this.history[this.historyIndex], false);
		this.markDirty();
	}

	markDirty() {
		this.dirty = true;
		this.updateChrome();
		if (this.options.onChange) this.options.onChange();
	}

	requestSave(force) {
		if (this.options.onSave) this.options.onSave(force);
	}

	ensureCell(r, c) {
		while (this.rows.length <= r) {
			this.rows.push(new Array(this.colCount()).fill(""));
		}
		const width = Math.max(this.colCount(), c + 1);
		for (const row of this.rows) {
			while (row.length < width) row.push("");
		}
	}

	colCount() {
		return this.rows[0] ? this.rows[0].length : 1;
	}

	rowCount() {
		return this.rows.length;
	}

	setCell(r, c, value) {
		this.ensureCell(r, c);
		if (this.rows[r][c] === value) return;
		this.rows[r][c] = value;
		this.pushHistory();
		this.markDirty();
		this.render();
		this.select(r, c);
	}

	insertRow(at) {
		const width = this.colCount();
		at = Math.max(0, Math.min(this.rowCount(), at));
		this.rows.splice(at, 0, new Array(width).fill(""));
		this.pushHistory();
		this.markDirty();
		this.render();
		this.select(at, this.sel.c);
	}

	deleteRow(at) {
		if (this.rowCount() <= 1) {
			this.rows[0] = this.rows[0].map(() => "");
		} else {
			this.rows.splice(at, 1);
		}
		this.pushHistory();
		this.markDirty();
		this.render();
		this.select(Math.min(at, this.rowCount() - 1), this.sel.c);
	}

	insertCol(at) {
		at = Math.max(0, Math.min(this.colCount(), at));
		for (const row of this.rows) row.splice(at, 0, "");
		this.pushHistory();
		this.markDirty();
		this.render();
		this.select(this.sel.r, at);
	}

	deleteCol(at) {
		if (this.colCount() <= 1) {
			for (const row of this.rows) row[0] = "";
		} else {
			for (const row of this.rows) row.splice(at, 1);
		}
		this.pushHistory();
		this.markDirty();
		this.render();
		this.select(this.sel.r, Math.min(at, this.colCount() - 1));
	}

	sort(col, asc) {
		if (this.rowCount() < 2) return;
		const header = this.rows[0];
		const body = this.rows.slice(1);
		body.sort((a, b) => {
			const av = a[col] || "";
			const bv = b[col] || "";
			const an = Number(av);
			const bn = Number(bv);
			let cmp;
			if (av !== "" && bv !== "" && !isNaN(an) && !isNaN(bn)) cmp = an - bn;
			else cmp = String(av).localeCompare(String(bv), "zh");
			return asc ? cmp : -cmp;
		});
		this.rows = [header, ...body];
		this.pushHistory();
		this.markDirty();
		this.render();
	}

	move(dr, dc) {
		this.closePopover();
		const r = Math.max(0, Math.min(this.rowCount() - 1, this.sel.r + dr));
		const c = Math.max(0, Math.min(this.colCount() - 1, this.sel.c + dc));
		this.select(r, c);
	}

	select(r, c) {
		this.sel = { r, c };
		const tds = this.scroll.querySelectorAll("td[data-r]");
		tds.forEach((td) => td.classList.toggle("is-selected", Number(td.dataset.r) === r && Number(td.dataset.c) === c));
		const td = this.scroll.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
		if (td) td.scrollIntoView({ block: "nearest", inline: "nearest" });
		this.updateChrome();
	}

	startEdit(initial) {
		const { r, c } = this.sel;
		const current = this.rows[r][c] || "";
		if (this.isLongContent(current) || (initial != null && this.isLongContent(String(current) + initial))) {
			this.startEditPopover(r, c, initial);
			return;
		}
		const td = this.scroll.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
		if (!td) return;
		this.editing = true;
		td.empty();
		td.addClass("is-editing");
		const input = td.createEl("input", { cls: "csv-wb-input", attr: { type: "text" } });
		input.value = initial != null ? initial : current;
		this.editOriginal = current;
		input.focus();
		if (initial == null) input.select();
		else input.selectionStart = input.selectionEnd = input.value.length;
		const commit = (next) => {
			if (!this.editing) return;
			this.editing = false;
			this.setCell(r, c, next);
			this.root.focus();
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commit(input.value);
				this.move(e.shiftKey ? -1 : 1, 0);
			} else if (e.key === "Tab") {
				e.preventDefault();
				commit(input.value);
				this.move(0, e.shiftKey ? -1 : 1);
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.editing = false;
				this.render();
				this.select(r, c);
				this.root.focus();
			}
			e.stopPropagation();
		});
		input.addEventListener("blur", () => {
			if (this.editing) commit(input.value);
		});
	}

	cancelEdit() {
		this.editing = false;
		this.closePopover();
		this.render();
		this.select(this.sel.r, this.sel.c);
		this.root.focus();
	}

	copy() {
		const v = this.rows[this.sel.r] ? this.rows[this.sel.r][this.sel.c] || "" : "";
		navigator.clipboard.writeText(v);
		new Notice("已复制单元格");
	}

	cut() {
		this.copy();
		this.setCell(this.sel.r, this.sel.c, "");
	}

	async pasteText(text) {
		if (!text) return;
		const parsed = parseCsv(text.indexOf("\t") !== -1 && text.indexOf(",") === -1 ? text.replace(/\t/g, ",") : text);
		if (parsed.rows.length === 1 && parsed.rows[0].length === 1) {
			this.setCell(this.sel.r, this.sel.c, parsed.rows[0][0]);
			return;
		}
		const startR = this.sel.r;
		const startC = this.sel.c;
		for (let i = 0; i < parsed.rows.length; i++) {
			for (let j = 0; j < parsed.rows[i].length; j++) {
				this.ensureCell(startR + i, startC + j);
				this.rows[startR + i][startC + j] = parsed.rows[i][j];
			}
		}
		this.pushHistory();
		this.markDirty();
		this.render();
		this.select(startR, startC);
	}

	applyFilter() {
		const q = (this.filter || "").trim().toLowerCase();
		const trs = this.scroll.querySelectorAll("tbody tr");
		trs.forEach((tr) => {
			if (!q) {
				tr.classList.remove("is-filtered-out");
				return;
			}
			const hit = Array.from(tr.querySelectorAll("td[data-r]")).some((td) =>
				(td.textContent || "").toLowerCase().includes(q)
			);
			tr.classList.toggle("is-filtered-out", !hit);
		});
		this.updateChrome();
	}

	esc(s) {
		return String(s == null ? "" : s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
	}

	render() {
		this.closePopover();
		const showNums = this.options.showRowNumbers !== false;
		const maxRows = this.options.maxRows || 0;
		const total = this.rowCount();
		const shown = maxRows > 0 ? Math.min(total, maxRows) : total;
		this.scroll.empty();
		const table = this.scroll.createEl("table", { cls: "csv-wb-table" });
		const thead = table.createEl("thead");
		const hr = thead.createEl("tr");
		if (showNums) hr.createEl("th", { cls: "csv-wb-corner", text: "" });
		for (let c = 0; c < this.colCount(); c++) {
			const th = hr.createEl("th", { text: colLetter(c), attr: { title: "点击按此列排序" } });
			th.dataset.c = String(c);
			th.addEventListener("click", () => this.sort(c, true));
			th.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				const menu = new Menu();
				menu.addItem((i) => i.setTitle("升序").onClick(() => this.sort(c, true)));
				menu.addItem((i) => i.setTitle("降序").onClick(() => this.sort(c, false)));
				menu.addSeparator();
				menu.addItem((i) => i.setTitle("左侧插入列").onClick(() => this.insertCol(c)));
				menu.addItem((i) => i.setTitle("右侧插入列").onClick(() => this.insertCol(c + 1)));
				menu.addItem((i) => i.setTitle("删除此列").onClick(() => this.deleteCol(c)));
				menu.showAtMouseEvent(e);
			});
		}
		const tbody = table.createEl("tbody");
		for (let r = 0; r < shown; r++) {
			const tr = tbody.createEl("tr");
			if (r === 0) tr.addClass("csv-wb-head-row");
			if (showNums) {
				const rn = tr.createEl("td", { cls: "csv-wb-rownum", text: String(r + 1) });
				rn.addEventListener("contextmenu", (e) => {
					e.preventDefault();
					const menu = new Menu();
					menu.addItem((i) => i.setTitle("上方插入行").onClick(() => this.insertRow(r)));
					menu.addItem((i) => i.setTitle("下方插入行").onClick(() => this.insertRow(r + 1)));
					menu.addItem((i) => i.setTitle("删除此行").onClick(() => this.deleteRow(r)));
					menu.addItem((i) => i.setTitle("复制此行").onClick(() => {
						this.rows.splice(r + 1, 0, this.rows[r].slice());
						this.pushHistory();
						this.markDirty();
						this.render();
					}));
					menu.showAtMouseEvent(e);
				});
			}
			for (let c = 0; c < this.colCount(); c++) {
				const cellVal = this.rows[r][c] || "";
				const td = tr.createEl("td");
				td.dataset.r = String(r);
				td.dataset.c = String(c);
				td.setText(cellVal);
				if (this.isLongContent(cellVal)) td.addClass("is-clipped");
				if (r === this.sel.r && c === this.sel.c) td.addClass("is-selected");
				td.addEventListener("click", (e) => {
					if (e.button !== 0) return;
					this.select(r, c);
					this.root.focus();
					if (this.isLongContent(cellVal)) this.showPreviewPopover(td, r, c);
					else this.closePopover();
				});
				td.addEventListener("dblclick", (e) => {
					e.preventDefault();
					this.select(r, c);
					if (this.isLongContent(cellVal)) this.startEditPopover(r, c);
					else this.startEdit();
				});
				td.addEventListener("contextmenu", (e) => {
					e.preventDefault();
					this.select(r, c);
					const menu = new Menu();
					menu.addItem((i) => i.setTitle("编辑").onClick(() => {
						if (this.isLongContent(this.rows[r][c] || "")) this.startEditPopover(r, c);
						else this.startEdit();
					}));
					menu.addItem((i) => i.setTitle("清空").onClick(() => this.setCell(r, c, "")));
					menu.addSeparator();
					menu.addItem((i) => i.setTitle("上方插入行").onClick(() => this.insertRow(r)));
					menu.addItem((i) => i.setTitle("下方插入行").onClick(() => this.insertRow(r + 1)));
					menu.addItem((i) => i.setTitle("左侧插入列").onClick(() => this.insertCol(c)));
					menu.addItem((i) => i.setTitle("右侧插入列").onClick(() => this.insertCol(c + 1)));
					menu.showAtMouseEvent(e);
				});
			}
		}
		if (maxRows > 0 && total > maxRows) {
			const more = this.scroll.createDiv({ cls: "csv-wb-empty" });
			more.setText(`笔记内嵌只显示前 ${maxRows} 行（共 ${total} 行）。点击文件名打开完整编辑。`);
		}
		this.applyFilter();
		this.updateChrome();
	}

	updateChrome() {
		const delim = this.meta.delimiter === "\t" ? "Tab" : this.meta.delimiter;
		this.metaEl.setText(`${this.rowCount()} × ${this.colCount()}  ·  分隔符 ${delim}`);
		this.saveBtn.toggleClass("csv-wb-save-dirty", this.dirty);
		this.saveBtn.setText(this.dirty ? "保存 *" : "保存");
		this.status.empty();
		const pos = this.status.createSpan({ text: `${colLetter(this.sel.c)}${this.sel.r + 1}` });
		const dirty = this.status.createSpan({ text: this.dirty ? "未保存" : "已保存" });
		dirty.toggleClass("is-dirty", this.dirty);
		this.status.createSpan({ text: this.options.filePath || "" });
		void pos;
	}
}

class CsvView extends TextFileView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.grid = null;
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return this.file ? this.file.basename : "CSV";
	}

	getIcon() {
		return "table";
	}

	async onOpen() {
		if (super.onOpen) await super.onOpen();
		this.contentEl.empty();
		this.contentEl.addClass("csv-wb-host");
		this.grid = new CsvGrid(this.contentEl, {
			showRowNumbers: this.plugin.settings.showRowNumbers,
			filePath: this.file ? this.file.path : "",
			onChange: () => {
				if (this.plugin.settings.autoSave) this.requestSave();
			},
			onSave: () => this.save(),
			onReload: async () => {
				if (!this.file) return;
				const text = await this.app.vault.read(this.file);
				this.grid.load(text);
				new Notice("已从磁盘重新加载");
			},
		});
		if (this.data) this.grid.load(this.data);
		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				if (!this.file || file.path !== this.file.path) return;
				if (this.grid && this.grid.dirty) return;
				const text = await this.app.vault.read(file);
				if (this.grid && text !== this.grid.serialize()) this.grid.load(text);
			})
		);
	}

	async onClose() {
		if (this.grid) this.grid.destroy();
		this.grid = null;
	}

	getViewData() {
		return this.grid ? this.grid.serialize() : this.data || "";
	}

	setViewData(data, clear) {
		this.data = data;
		if (this.grid) {
			this.grid.options.filePath = this.file ? this.file.path : "";
			this.grid.load(data || "");
		}
	}

	clear() {
		if (this.grid) this.grid.load("");
	}
}

class CsvEmbed extends MarkdownRenderChild {
	constructor(containerEl, plugin, file, sourcePath) {
		super(containerEl);
		this.plugin = plugin;
		this.file = file;
		this.sourcePath = sourcePath;
		this.grid = null;
	}

	async onload() {
		this.containerEl.empty();
		this.wrapper = this.containerEl.createDiv({ cls: "csv-wb-embed" });
		const title = this.wrapper.createDiv({ cls: "csv-wb-embed-title" });
		const link = title.createEl("a", { text: this.file.path, href: this.file.path });
		link.addEventListener("click", (e) => {
			e.preventDefault();
			this.plugin.app.workspace.getLeaf(false).openFile(this.file);
		});
		title.createSpan({ text: "可编辑 · 保存写回 CSV" });
		this.host = this.wrapper.createDiv();
		await this.renderGrid();
		this.registerEvent(
			this.plugin.app.vault.on("modify", async (f) => {
				if (f.path === this.file.path && this.grid && !this.grid.dirty) {
					const text = await this.plugin.app.vault.read(this.file);
					this.grid.load(text);
				}
			})
		);
	}

	async renderGrid() {
		const text = await this.plugin.app.vault.read(this.file);
		this.grid = new CsvGrid(this.host, {
			showRowNumbers: this.plugin.settings.showRowNumbers,
			maxRows: this.plugin.settings.embedMaxRows,
			filePath: this.file.path,
			onChange: () => {},
			onSave: async () => {
				await this.plugin.app.vault.modify(this.file, this.grid.serialize());
				this.grid.dirty = false;
				this.grid.updateChrome();
				new Notice("已写回 " + this.file.path);
			},
			onReload: async () => {
				const t = await this.plugin.app.vault.read(this.file);
				this.grid.load(t);
			},
		});
		this.grid.load(text);
		this.grid.options.onChange = () => {
			if (this.plugin.settings.autoSave) this.grid.requestSave(true);
		};
	}

	onunload() {
		if (this.grid) this.grid.destroy();
	}
}

class CsvWorkbenchSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "CSV Workbench" });

		new Setting(containerEl)
			.setName("拖拽保存位置")
			.setDesc("把 CSV 拖进笔记时，文件落到哪里")
			.addDropdown((d) => {
				d.addOption("same", "与当前笔记同一文件夹")
					.addOption("attachment", "附件文件夹")
					.addOption("custom", "自定义文件夹")
					.setValue(this.plugin.settings.dropFolder)
					.onChange(async (v) => {
						this.plugin.settings.dropFolder = v;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("自定义文件夹")
			.setDesc("例如 _csv 或 inventory")
			.addText((t) => {
				t.setPlaceholder("_csv")
					.setValue(this.plugin.settings.customFolder)
					.onChange(async (v) => {
						this.plugin.settings.customFolder = v.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("插入方式")
			.setDesc("拖入后在笔记里插入什么")
			.addDropdown((d) => {
				d.addOption("embed", "嵌入 ![[file.csv]]（推荐，笔记里直接出表）")
					.addOption("wikilink", "链接 [[file.csv]]")
					.addOption("markdown", "Markdown 链接")
					.setValue(this.plugin.settings.insertStyle)
					.onChange(async (v) => {
						this.plugin.settings.insertStyle = v;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("同名则复用")
			.setDesc("目标路径已有同名 CSV 时，不再生成 coverage 1.csv，直接嵌入已有文件")
			.addToggle((t) => {
				t.setValue(this.plugin.settings.reuseExisting).onChange(async (v) => {
					this.plugin.settings.reuseExisting = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("自动保存")
			.setDesc("改单元格后写回 CSV。关掉则需点保存 / Ctrl+S。磁盘上这份文件给任意 Agent 或编辑器读。")
			.addToggle((t) => {
				t.setValue(this.plugin.settings.autoSave).onChange(async (v) => {
					this.plugin.settings.autoSave = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("显示行号")
			.addToggle((t) => {
				t.setValue(this.plugin.settings.showRowNumbers).onChange(async (v) => {
					this.plugin.settings.showRowNumbers = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("笔记内嵌最大行数")
			.setDesc("完整文件请点击文件名打开。避免一篇笔记嵌进上千行把预览拖垮。")
			.addText((t) => {
				t.setValue(String(this.plugin.settings.embedMaxRows)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n > 0) {
						this.plugin.settings.embedMaxRows = n;
						await this.plugin.saveSettings();
					}
				});
			});
	}
}

class NewCsvModal extends Modal {
	constructor(app, plugin, folder) {
		super(app);
		this.plugin = plugin;
		this.folder = folder;
	}
	onOpen() {
		this.titleEl.setText("新建 CSV");
		const box = this.contentEl.createDiv();
		box.createEl("p", { text: "文件名（不含路径）" });
		this.input = box.createEl("input", { cls: "csv-wb-search", attr: { type: "text", placeholder: "untitled.csv" } });
		this.input.value = "untitled.csv";
		this.input.style.width = "100%";
		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") this.submit();
		});
		const row = box.createDiv();
		row.style.marginTop = "12px";
		const ok = row.createEl("button", { cls: "mod-cta", text: "创建" });
		ok.addEventListener("click", () => this.submit());
		this.input.focus();
	}
	async submit() {
		let name = (this.input.value || "untitled.csv").trim();
		if (!hasExt(name, ["csv", "tsv"])) name += ".csv";
		const folder = this.folder ? this.folder.replace(/\/$/, "") : "";
		const path = folder ? `${folder}/${name}` : name;
		if (this.app.vault.getAbstractFileByPath(path)) {
			new Notice("已存在：" + path);
			return;
		}
		const file = await this.app.vault.create(path, "列1,列2,列3\n,,\n");
		this.close();
		this.app.workspace.getLeaf(false).openFile(file);
	}
}

class CsvWorkbenchPlugin extends Plugin {
	async onload() {
		await this.loadSettings();
		this.injectCss();
		this.ensureDetectAllExtensions();

		this.registerView(VIEW_TYPE, (leaf) => new CsvView(leaf, this));
		this.registerCsvExtension("csv");
		if (this.settings.enableTsv) this.registerCsvExtension("tsv");

		this.registerMarkdownCodeBlockProcessor("csv", (source, el, ctx) => this.renderCodeBlock(source, el, ctx));
		this.registerMarkdownCodeBlockProcessor("csvtable", (source, el, ctx) => this.renderCodeBlock(source, el, ctx));
		this.registerMarkdownPostProcessor((el, ctx) => this.upgradeCsvEmbeds(el, ctx));
		this.tryRegisterEmbedRegistry();

		this.registerEvent(this.app.workspace.on("editor-drop", (evt, editor, info) => this.onEditorDrop(evt, editor, info)));
		this.registerEvent(this.app.workspace.on("editor-paste", (evt, editor, info) => this.onEditorPaste(evt, editor, info)));
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => this.onFileMenu(menu, file)));
		this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, info) => this.onEditorMenu(menu, editor, info)));

		this.addRibbonIcon("table", "CSV Workbench：新建 CSV", () => this.createNewCsv());
		this.addCommand({ id: "create-csv", name: "新建 CSV 文件", callback: () => this.createNewCsv() });
		this.addCommand({
			id: "import-csv-into-note",
			name: "导入 CSV 到当前笔记",
			callback: () => this.importCsvViaPicker(),
		});
		this.addCommand({
			id: "save-csv",
			name: "保存当前 CSV",
			callback: () => {
				const view = this.app.workspace.getActiveViewOfType(CsvView);
				if (view) view.save();
				else new Notice("当前不是 CSV 视图");
			},
		});
		this.addCommand({
			id: "reload-csv",
			name: "从磁盘重载当前 CSV",
			callback: async () => {
				const view = this.app.workspace.getActiveViewOfType(CsvView);
				if (view && view.file && view.grid) {
					view.grid.load(await this.app.vault.read(view.file));
					new Notice("已重载");
				}
			},
		});

		this.addSettingTab(new CsvWorkbenchSettingTab(this.app, this));
	}

	onunload() {
		try {
			if (this.app.embedRegistry && this.app.embedRegistry.unregisterExtension) {
				this.app.embedRegistry.unregisterExtension("csv");
				this.app.embedRegistry.unregisterExtension("tsv");
			}
		} catch (e) {}
	}

	injectCss() {
		if (document.getElementById("csv-wb-excel-css")) return;
		try {
			const fs = require("fs");
			const path = require("path");
			const cssPath = path.join(this.manifest.dir, "styles.css");
			const css = fs.readFileSync(cssPath, "utf8");
			const el = document.createElement("style");
			el.id = "csv-wb-excel-css";
			el.textContent = css;
			document.head.appendChild(el);
			this.register(() => el.remove());
		} catch (e) {}
	}

	registerCsvExtension(ext) {
		try {
			this.registerExtensions([ext], VIEW_TYPE);
		} catch (e) {
			try {
				this.app.viewRegistry.unregisterExtensions([ext]);
				this.registerExtensions([ext], VIEW_TYPE);
			} catch (e2) {
				console.warn("CSV Workbench: cannot register ." + ext, e2);
			}
		}
	}

	ensureDetectAllExtensions() {
		try {
			if (this.app.vault.getConfig && !this.app.vault.getConfig("detectAllFileExtensions")) {
				this.app.vault.setConfig("detectAllFileExtensions", true);
			}
		} catch (e) {}
	}

	tryRegisterEmbedRegistry() {
		if (!this.app.embedRegistry || !this.app.embedRegistry.registerExtension) return;
		const create = (ctx, file) => {
			const child = new CsvEmbed(ctx.containerEl, this, file, ctx.sourcePath);
			child.load();
			return child;
		};
		try {
			this.app.embedRegistry.registerExtension("csv", create);
			this.app.embedRegistry.registerExtension("tsv", create);
		} catch (e) {}
	}

	async upgradeCsvEmbeds(el, ctx) {
		const embeds = el.querySelectorAll(".internal-embed");
		for (const embed of Array.from(embeds)) {
			const src = embed.getAttribute("src") || "";
			if (!hasExt(src.split("#")[0], ["csv", "tsv"])) continue;
			if (embed.querySelector(".csv-wb-embed")) continue;
			const path = src.split("#")[0];
			const file = this.app.metadataCache.getFirstLinkpathDest(path, ctx.sourcePath || "");
			if (!(file instanceof TFile)) continue;
			embed.empty();
			ctx.addChild(new CsvEmbed(embed, this, file, ctx.sourcePath));
		}
	}

	async renderCodeBlock(source, el, ctx) {
		const trimmed = source.trim();
		const pathMatch = trimmed.match(/^(?:file|path|source)\s*[:=]\s*(.+)$/im) || (trimmed.split(/\n/).length === 1 && hasExt(trimmed, ["csv", "tsv"]) ? [null, trimmed] : null);
		if (pathMatch) {
			const rel = pathMatch[1].trim().replace(/^\[\[|\]\]$/g, "").replace(/^["']|["']$/g, "");
			const file = this.app.metadataCache.getFirstLinkpathDest(rel, ctx.sourcePath || "");
			if (!(file instanceof TFile)) {
				el.createDiv({ cls: "csv-wb-error", text: "找不到 CSV：" + rel });
				return;
			}
			ctx.addChild(new CsvEmbed(el, this, file, ctx.sourcePath));
			return;
		}
		const grid = new CsvGrid(el, { showRowNumbers: this.settings.showRowNumbers, maxRows: this.settings.embedMaxRows });
		grid.load(source);
		grid.saveBtn.style.display = "none";
	}

	folderOf(file) {
		if (!file) return "";
		const i = file.path.lastIndexOf("/");
		return i === -1 ? "" : file.path.slice(0, i);
	}

	async resolveDropFolder(sourcePath) {
		const srcFile = sourcePath ? this.app.vault.getAbstractFileByPath(sourcePath) : this.app.workspace.getActiveFile();
		const mode = this.settings.dropFolder;
		if (mode === "custom" && this.settings.customFolder) {
			const folder = this.settings.customFolder.replace(/^\/|\/$/g, "");
			if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
				await this.app.vault.createFolder(folder);
			}
			return folder;
		}
		if (mode === "attachment") {
			const dummy = await this.app.fileManager.getAvailablePathForAttachment("csv-workbench-dummy.csv", sourcePath);
			const i = dummy.lastIndexOf("/");
			return i === -1 ? "" : dummy.slice(0, i);
		}
		return srcFile instanceof TFile ? this.folderOf(srcFile) : "";
	}

	async importDroppedFile(file, sourcePath) {
		const folder = await this.resolveDropFolder(sourcePath);
		const destPath = folder ? `${folder}/${file.name}` : file.name;
		const existing = this.app.vault.getAbstractFileByPath(destPath);
		if (existing instanceof TFile && this.settings.reuseExisting) return existing;
		const text = await readDroppedFile(file);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, text);
			return existing;
		}
		let path = destPath;
		if (this.app.vault.getAbstractFileByPath(path)) {
			path = await this.app.fileManager.getAvailablePathForAttachment(file.name, sourcePath);
		}
		const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (parent && !this.app.vault.getAbstractFileByPath(parent)) {
			await this.app.vault.createFolder(parent);
		}
		return await this.app.vault.create(path, text);
	}

	insertLink(editor, sourcePath, tfile) {
		const style = this.settings.insertStyle;
		if (style === "markdown") {
			const md = this.app.fileManager.generateMarkdownLink(tfile, sourcePath || "", "", "");
			editor.replaceSelection((md.startsWith("!") ? md : "!" + md) + "\n");
			return;
		}
		const alias = tfile.basename;
		const path = tfile.path;
		if (style === "wikilink") editor.replaceSelection(`[[${path}|${alias}]]\n`);
		else editor.replaceSelection(`![[${path}]]\n`);
	}

	onEditorDrop(evt, editor, info) {
		const files = csvFilesFromEvent(evt);
		if (!files.length) return false;
		evt.preventDefault();
		if (evt.stopPropagation) evt.stopPropagation();
		if (evt.stopImmediatePropagation) evt.stopImmediatePropagation();
		const sourcePath = (info && info.file && info.file.path) || (this.app.workspace.getActiveFile() || {}).path || "";
		(async () => {
			for (const file of files) {
				try {
					const tfile = await this.importDroppedFile(file, sourcePath);
					this.insertLink(editor, sourcePath, tfile);
					new Notice("已导入 " + tfile.path);
				} catch (e) {
					new Notice("导入失败：" + (e && e.message ? e.message : e));
				}
			}
		})();
		return true;
	}

	onEditorPaste(evt, editor, info) {
		const files = csvFilesFromEvent(evt);
		if (!files.length) return;
		evt.preventDefault();
		this.onEditorDrop(evt, editor, info);
	}

	onFileMenu(menu, file) {
		if (!(file instanceof TFile) || !hasExt(file.path, ["csv", "tsv"])) return;
		menu.addItem((i) => {
			i.setTitle("用 CSV Workbench 打开")
				.setIcon("table")
				.onClick(() => this.app.workspace.getLeaf(false).openFile(file));
		});
	}

	onEditorMenu(menu, editor, info) {
		menu.addItem((i) => {
			i.setTitle("导入 CSV 到当前笔记")
				.setIcon("table")
				.onClick(() => this.importCsvViaPicker());
		});
	}

	createNewCsv() {
		const active = this.app.workspace.getActiveFile();
		const folder = active ? this.folderOf(active) : "";
		new NewCsvModal(this.app, this, folder).open();
	}

	importCsvViaPicker() {
		const input = document.createEl("input", { attr: { type: "file", accept: ".csv,.tsv,text/csv" } });
		input.multiple = true;
		input.addEventListener("change", async () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			const editor = view && view.editor;
			const sourcePath = (view && view.file && view.file.path) || "";
			if (!editor) {
				new Notice("请先打开一篇笔记再导入");
				return;
			}
			for (const file of Array.from(input.files || [])) {
				const tfile = await this.importDroppedFile(file, sourcePath);
				this.insertLink(editor, sourcePath, tfile);
			}
		});
		input.click();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

module.exports = CsvWorkbenchPlugin;
