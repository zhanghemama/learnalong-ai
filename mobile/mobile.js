const STORAGE_KEY = "learnAlongAi.mobile.v1";

const els = {
  installHint: document.querySelector("#installHint"),
  sourceInput: document.querySelector("#sourceInput"),
  pasteButton: document.querySelector("#pasteButton"),
  explainButton: document.querySelector("#explainButton"),
  result: document.querySelector("#result"),
  notes: document.querySelector("#notes"),
  copyLatest: document.querySelector("#copyLatest"),
  exportLatest: document.querySelector("#exportLatest"),
  copyAll: document.querySelector("#copyAll"),
  clearAll: document.querySelector("#clearAll")
};

let state = {
  notes: [],
  latest: ""
};

init();

async function init() {
  loadState();
  hydrateSharedInput();
  bindEvents();
  render();
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("/mobile/service-worker.js").catch(() => {});
  }
}

function bindEvents() {
  els.installHint.addEventListener("click", () => {
    showToast("手机浏览器菜单里选择“添加到主屏幕”。");
  });
  els.pasteButton.addEventListener("click", pasteFromClipboard);
  els.explainButton.addEventListener("click", explainAndSave);
  els.copyLatest.addEventListener("click", () => copyText(state.latest || els.result.textContent, "已复制最新笔记"));
  els.exportLatest.addEventListener("click", () => downloadMarkdown(state.latest, `learnalong-ai-note-${dayKey()}.md`));
  els.copyAll.addEventListener("click", () => copyText(buildArchiveMarkdown(), "已复制全部手机笔记"));
  els.clearAll.addEventListener("click", clearAllNotes);
}

function loadState() {
  try {
    state = { ...state, ...(JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}) };
  } catch (_error) {
    state = { notes: [], latest: "" };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function hydrateSharedInput() {
  const params = new URLSearchParams(location.search);
  const sharedText = [params.get("title"), params.get("text"), params.get("url")]
    .filter(Boolean)
    .join("\n");
  if (sharedText) {
    els.sourceInput.value = sharedText;
    history.replaceState({}, document.title, "/mobile/");
  }
}

async function pasteFromClipboard() {
  try {
    els.sourceInput.value = await navigator.clipboard.readText();
    showToast("已粘贴");
  } catch (_error) {
    showToast("无法读取剪贴板，请手动粘贴。");
  }
}

async function explainAndSave() {
  const input = els.sourceInput.value.trim();
  if (!input) {
    showToast("先粘贴链接或文本。");
    return;
  }

  els.explainButton.disabled = true;
  els.result.textContent = "正在解释...";

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "请解释这段手机端分享来的 AI 学习内容，并整理成易读 Markdown。",
        pageContext: {
          title: inferTitle(input),
          url: inferUrl(input),
          contentType: inferUrl(input) ? "shared-link" : "shared-text",
          text: input
        },
        memories: {
          blindSpots: [],
          notes: state.notes,
          sessions: [],
          transcriptions: []
        }
      })
    });
    const data = await response.json();
    const markdown = formatLearningNote(input, data.answer || "没有拿到回答。");
    state.latest = markdown;
    state.notes.push({
      title: inferTitle(input),
      source: inferUrl(input),
      markdown,
      createdAt: new Date().toISOString()
    });
    state.notes = state.notes.slice(-50);
    saveState();
    render();
    showToast("已保存学习笔记");
  } catch (error) {
    els.result.textContent = `解释失败：${error.message}`;
  } finally {
    els.explainButton.disabled = false;
  }
}

function formatLearningNote(input, answer) {
  const sourceUrl = inferUrl(input);
  return [
    `# ${inferTitle(input)}`,
    "",
    sourceUrl ? `资料：${sourceUrl}` : "",
    `时间：${formatDateTime(new Date().toISOString())}`,
    "",
    "## LearnAlong AI 解释",
    answer,
    "",
    "## 原始内容",
    input
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function render() {
  els.result.textContent = state.latest || "还没有内容。先粘贴一条链接或文本。";
  els.notes.innerHTML = "";
  if (!state.notes.length) {
    const empty = document.createElement("p");
    empty.textContent = "还没有手机端学习笔记。";
    els.notes.append(empty);
    return;
  }

  for (const note of state.notes.slice(-8).reverse()) {
    const item = document.createElement("article");
    item.className = "note";
    const title = document.createElement("div");
    title.className = "note-title";
    title.textContent = note.title || "学习笔记";
    const time = document.createElement("div");
    time.className = "note-time";
    time.textContent = formatDateTime(note.createdAt);
    item.append(title, time);
    els.notes.append(item);
  }
}

function buildArchiveMarkdown() {
  return [
    "# LearnAlong AI 手机笔记",
    "",
    `导出时间：${formatDateTime(new Date().toISOString())}`,
    "",
    ...state.notes
      .slice()
      .reverse()
      .map((note) => note.markdown)
  ].join("\n\n---\n\n");
}

function clearAllNotes() {
  state = { notes: [], latest: "" };
  saveState();
  render();
  showToast("已清空手机端笔记");
}

async function copyText(text, message) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast(message);
  } catch (_error) {
    showToast("复制失败，请手动选择复制。");
  }
}

function downloadMarkdown(markdown, fileName) {
  if (!markdown) return;
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function inferUrl(text) {
  return String(text || "").match(/https?:\/\/[^\s]+/)?.[0] || "";
}

function inferTitle(text) {
  const firstLine = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "手机分享学习笔记";
  return firstLine.replace(/^https?:\/\/[^\s]+$/, "手机分享链接").slice(0, 42);
}

function dayKey(dateValue = new Date().toISOString()) {
  const date = new Date(dateValue);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDateTime(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}

function showToast(message) {
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2200);
}
