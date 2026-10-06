// Small, safe Markdown renderer for chat replies. It builds DOM nodes directly (text nodes
// only, never innerHTML), and only http(s) links become anchors.
// Supports fenced code blocks, headings, nested lists, blockquotes, rules and paragraphs,
// plus inline code, bold, italics and links.

const FENCE_OPEN = /^\s*```\s*([\w+#.-]*)\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const HEADING = /^\s*(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const INLINE =
	/(`+)([\s\S]+?)\1|\*\*(.+?)\*\*|__(.+?)__|(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)|(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,:;!?"'])/g;

/** Renders Markdown text into a DocumentFragment. Unclosed code fences (mid-stream) render as code. */
export function renderMarkdown(text) {
	const root = document.createDocumentFragment();
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		let m;
		if (!line.trim()) {
			i++;
		} else if ((m = line.match(FENCE_OPEN))) {
			const code = [];
			i++;
			while (i < lines.length && !FENCE_CLOSE.test(lines[i])) code.push(lines[i++]);
			i++; // closing fence
			root.append(codeBlock(code.join("\n"), m[1]));
		} else if ((m = line.match(HEADING))) {
			const h = el(m[1].length <= 2 ? "h3" : "h4");
			appendInline(h, m[2]);
			root.append(h);
			i++;
		} else if (RULE.test(line)) {
			root.append(el("hr"));
			i++;
		} else if (LIST_ITEM.test(line)) {
			i = appendList(root, lines, i);
		} else if (QUOTE.test(line)) {
			const body = [];
			while (i < lines.length && (m = lines[i].match(QUOTE))) {
				body.push(m[1]);
				i++;
			}
			const quote = el("blockquote");
			quote.append(renderMarkdown(body.join("\n")));
			root.append(quote);
		} else {
			const para = [];
			do para.push(lines[i++]);
			while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]));
			const p = el("p");
			appendInline(p, para.join("\n"));
			root.append(p);
		}
	}
	return root;
}

function startsBlock(line) {
	return [FENCE_OPEN, HEADING, RULE, LIST_ITEM, QUOTE].some((re) => re.test(line));
}

/** Consumes consecutive list lines starting at `i`, nesting by indentation. Returns the next index. */
function appendList(root, lines, i) {
	const stack = []; // { indent, list }
	while (i < lines.length) {
		const m = lines[i].match(LIST_ITEM);
		if (!m) {
			const top = stack.at(-1);
			if (top && /^\s+\S/.test(lines[i])) {
				// An indented line continues the previous item.
				const li = top.list.lastElementChild;
				li.append("\n");
				appendInline(li, lines[i].trim());
				i++;
				continue;
			}
			// A blank line between items doesn't end the list.
			if (!lines[i].trim() && LIST_ITEM.test(lines[i + 1] ?? "")) {
				i++;
				continue;
			}
			break;
		}
		const indent = m[1].replace(/\t/g, "    ").length;
		const ordered = /\d/.test(m[2]);
		while (stack.length && indent < stack.at(-1).indent) stack.pop();
		// Switching between bullets and numbers at the same depth starts a new list.
		if (stack.length && indent === stack.at(-1).indent && ordered !== stack.at(-1).ordered) stack.pop();
		let top = stack.at(-1);
		if (!top || indent > top.indent) {
			const list = el(ordered ? "ol" : "ul");
			if (ordered && parseInt(m[2], 10) !== 1) list.start = parseInt(m[2], 10);
			(top ? top.list.lastElementChild : root).append(list);
			top = { indent, ordered, list };
			stack.push(top);
		}
		const li = el("li");
		appendInline(li, m[3]);
		top.list.append(li);
		i++;
	}
	return i;
}

function appendInline(parent, text) {
	let last = 0;
	for (const m of text.matchAll(INLINE)) {
		if (m.index > last) parent.append(text.slice(last, m.index));
		let node;
		if (m[1]) {
			node = el("code");
			node.textContent = m[2];
		} else if (m[3] ?? m[4]) {
			node = el("strong");
			appendInline(node, m[3] ?? m[4]);
		} else if (m[5] ?? m[6]) {
			node = el("em");
			appendInline(node, m[5] ?? m[6]);
		} else {
			node = el("a");
			node.href = m[8] ?? m[9];
			node.textContent = m[7] ?? m[9];
			node.target = "_blank";
			node.rel = "noopener noreferrer";
		}
		parent.append(node);
		last = m.index + m[0].length;
	}
	if (last < text.length) parent.append(text.slice(last));
}

function codeBlock(code, lang) {
	const wrap = el("div", "code-block");
	const head = el("div", "code-head");
	const label = el("span");
	label.textContent = lang || "code";
	const copy = el("button", "copy");
	copy.type = "button";
	copy.textContent = "Copy";
	head.append(label, copy);
	const pre = el("pre");
	const codeEl = el("code");
	codeEl.textContent = code;
	pre.append(codeEl);
	wrap.append(head, pre);
	return wrap;
}

function el(tag, className) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	return node;
}
