const $ = (id) => document.getElementById(id);

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function avatarUrl(ref) {
  if (!ref || ref === "uploaded") return null;
  if (ref.startsWith("http://") || ref.startsWith("https://")) return ref;
  if (ref.startsWith("/")) return ref;
  return "/" + ref.replaceAll("\\", "/");
}

function buildCharMap(data) {
  const map = new Map();
  for (const row of data.custom_chars || []) {
    const [charId, avatarRef, name] = row;
    map.set(charId, { avatarRef, name });
  }
  return map;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderChat(data) {
  const chat = $("chat");
  chat.innerHTML = "";
  const charMap = buildCharMap(data);

  for (const msg of data.chat || []) {
    const t = msg.yuzutalk?.type;
    if (t === "NARRATION") {
      const wrap = el("div", "narration");
      wrap.appendChild(el("div", "", msg.content ?? ""));
      chat.appendChild(wrap);
      continue;
    }

    const charId = msg.char_id || "__Sensei";
    const isSensei = charId === "__Sensei";
    const side = isSensei ? "right" : "left";
    const row = el("div", `row ${side} ${side === "left" ? "left" : "right"}`);

    const profile = charMap.get(charId) || {};
    const name = profile.name || (isSensei ? "" : charId);
    const avUrl = avatarUrl(profile.avatarRef);

    if (side === "left") {
      if (avUrl) {
        const img = el("img", "avatar");
        img.src = avUrl;
        img.alt = name;
        row.appendChild(img);
      } else {
        row.appendChild(el("div", "avatar"));
      }
    }

    const wrap = el("div", "bubble-wrap");
    if (side === "left" && name) wrap.appendChild(el("div", "name", name));
    wrap.appendChild(el("div", "bubble", msg.content ?? ""));
    row.appendChild(wrap);

    if (side === "right") {
      row.appendChild(el("div", "avatar"));
    }

    chat.appendChild(row);
  }
}

let lastJson = null;
let lastPdfUrl = null;

function setPdfUrl(url) {
  if (lastPdfUrl) URL.revokeObjectURL(lastPdfUrl);
  lastPdfUrl = url;
  $("pdf").src = url || "about:blank";
  $("open-pdf").disabled = !url;
}

function showTab(kind) {
  const chatBtn = $("show-chat");
  const pdfBtn = $("show-pdf");
  const chat = $("chat");
  const pdfWrap = $("pdf-wrap");
  if (kind === "pdf") {
    chatBtn.classList.remove("active");
    pdfBtn.classList.add("active");
    chat.classList.add("hidden");
    pdfWrap.classList.remove("hidden");
  } else {
    pdfBtn.classList.remove("active");
    chatBtn.classList.add("active");
    pdfWrap.classList.add("hidden");
    chat.classList.remove("hidden");
  }
}

async function parse() {
  const text = $("input").value;
  $("hint").textContent = "解析中…";
  $("download-json").disabled = true;
  $("render-pdf").disabled = true;
  $("pdf-hint").textContent = "";
  setPdfUrl(null);

  const resp = await fetch("/api/parse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, join: "newline" }),
  });

  const body = await resp.json();
  if (!resp.ok) {
    $("hint").textContent = body?.detail ? `错误：${body.detail}` : "错误：解析失败";
    return;
  }

  lastJson = body.data;
  renderChat(body.data);

  const unresolved = Object.values(body.report?.unresolved_speakers || {}).reduce((a, b) => a + b, 0);
  const ambiguous = Object.values(body.report?.ambiguous_speakers || {}).reduce((a, b) => a + b, 0);
  $("hint").textContent = `messages=${body.report.message_count} custom_chars=${body.report.custom_char_count} unresolved=${unresolved} ambiguous=${ambiguous}`;
  $("download-json").disabled = false;
  $("render-pdf").disabled = false;
}

$("parse").addEventListener("click", () => parse().catch((e) => ($("hint").textContent = `错误：${e}`)));

$("download-json").addEventListener("click", () => {
  if (!lastJson) return;
  downloadText("mmt.json", JSON.stringify(lastJson, null, 2));
});

$("show-chat").addEventListener("click", () => showTab("chat"));
$("show-pdf").addEventListener("click", () => showTab("pdf"));

$("open-pdf").addEventListener("click", () => {
  if (!lastPdfUrl) return;
  window.open(lastPdfUrl, "_blank", "noopener,noreferrer");
});

$("render-pdf").addEventListener("click", async () => {
  const text = $("input").value;
  $("pdf-hint").textContent = "生成中…";
  showTab("pdf");
  setPdfUrl(null);
  $("render-pdf").disabled = true;
  try {
    const resp = await fetch("/api/render_pdf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, join: "newline" }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => null);
      $("pdf-hint").textContent = body?.detail ? `错误：${body.detail}` : "错误：生成失败";
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    setPdfUrl(url);
    $("pdf-hint").textContent = "已生成。";
  } catch (e) {
    $("pdf-hint").textContent = `错误：${e}`;
  } finally {
    $("render-pdf").disabled = false;
  }
});

$("file").addEventListener("change", async (ev) => {
  const f = ev.target.files?.[0];
  if (!f) return;
  const text = await f.text();
  $("input").value = text;
});

showTab("chat");

(async () => {
  // Default sample: only load when textarea is empty.
  if ($("input").value.trim()) return;
  try {
    const resp = await fetch("/api/sample");
    if (!resp.ok) return;
    const body = await resp.json();
    if (body?.text) $("input").value = body.text;
  } catch {
    // ignore
  }
})();
