const STORAGE_KEY = "learnAlongAi.v1";
const DIGEST_ALARM = "learnalong-ai-daily-digest";
const SERVER_BASE = "http://localhost:8787";

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
  chrome.alarms.clear(DIGEST_ALARM);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (chrome.sidePanel?.open) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_ACTIVE_TAB_CONTEXT") {
    getActiveTabContext()
      .then((context) => sendResponse({ ok: true, context }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message?.type === "PAUSE_ACTIVE_VIDEO") {
    controlActiveTabVideo("PAUSE_ACTIVE_VIDEO")
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "RESUME_ACTIVE_VIDEO") {
    controlActiveTabVideo("RESUME_ACTIVE_VIDEO")
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "START_TAB_AUDIO_TRANSCRIPTION") {
    startTabAudioTranscription(message.sourceTab)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "START_TAB_AUDIO_TRANSCRIPTION_WITH_STREAM") {
    startTabAudioTranscriptionWithStream(message.streamId, message.sourceTab)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "STOP_TAB_AUDIO_TRANSCRIPTION") {
    sendToOffscreen({ type: "STOP_TAB_AUDIO_RECORDING", target: "offscreen" })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SET_DAILY_DIGEST_AUTOMATION") {
    chrome.alarms
      .clear(DIGEST_ALARM)
      .then(() => sendResponse({ ok: true, scheduledAt: null }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DIGEST_ALARM) {
    chrome.alarms.clear(DIGEST_ALARM);
  }
});

async function getActiveTabContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");
  if (isRestrictedBrowserUrl(tab.url)) {
    throw new Error("Chrome 设置页、插件管理页和扩展页不能被读取。请切到 YouTube、X 或普通网页后，再点 LearnAlong AI 里的刷新。");
  }

  try {
    return await sendExtractMessage(tab.id);
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    return await sendExtractMessage(tab.id);
  }
}

function isRestrictedBrowserUrl(url = "") {
  return /^(chrome|edge|brave|vivaldi|opera|about|devtools|chrome-extension):\/\//i.test(url);
}

function sendExtractMessage(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "EXTRACT_PAGE_CONTEXT" }, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Failed to extract page context."));
        return;
      }
      resolve(response.context);
    });
  });
}

async function controlActiveTabVideo(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");
  if (isRestrictedBrowserUrl(tab.url)) {
    throw new Error("Chrome 设置页、插件管理页和扩展页不能控制视频。请切到 YouTube 或普通网页后再试。");
  }

  try {
    return await sendVideoControlMessage(tab.id, type);
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    return await sendVideoControlMessage(tab.id, type);
  }
}

function sendVideoControlMessage(tabId, type) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type }, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Failed to control active video."));
        return;
      }
      resolve(response);
    });
  });
}

async function startTabAudioTranscription(sourceTabFromSender) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");

  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  return await sendToOffscreen({
    type: "START_TAB_AUDIO_RECORDING",
    target: "offscreen",
    streamId,
    sourceTab: sourceTabFromSender || {
      id: tab.id,
      title: tab.title || "",
      url: tab.url || ""
    }
  });
}

async function startTabAudioTranscriptionWithStream(streamId, sourceTab) {
  if (!streamId) throw new Error("Missing tab audio stream id.");
  await ensureOffscreenDocument();
  return await sendToOffscreen({
    type: "START_TAB_AUDIO_RECORDING",
    target: "offscreen",
    streamId,
    sourceTab
  });
}

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")]
  });

  if (existingContexts.length) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Record current tab audio for AI study transcription."
  });
}

function sendToOffscreen(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Offscreen operation failed."));
        return;
      }
      resolve(response);
    });
  });
}

async function setDigestAutomation(enabled) {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const state = stored[STORAGE_KEY] || {};
  const settings = {
    ...(state.settings || {}),
    dailyDigestEnabled: Boolean(enabled),
    dailyDigestTime: state.settings?.dailyDigestTime || "21:30"
  };
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      ...state,
      settings
    }
  });

  if (settings.dailyDigestEnabled) {
    await scheduleDailyDigest(settings.dailyDigestTime);
    return { scheduledAt: nextDigestDate(settings.dailyDigestTime).toISOString() };
  }

  await chrome.alarms.clear(DIGEST_ALARM);
  return { scheduledAt: null };
}

async function scheduleDigestFromStorage() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const settings = stored[STORAGE_KEY]?.settings || {};
  if (settings.dailyDigestEnabled) {
    await scheduleDailyDigest(settings.dailyDigestTime || "21:30");
  }
}

async function scheduleDailyDigest(timeText) {
  await chrome.alarms.clear(DIGEST_ALARM);
  chrome.alarms.create(DIGEST_ALARM, {
    when: nextDigestDate(timeText).getTime(),
    periodInMinutes: 24 * 60
  });
}

function nextDigestDate(timeText = "21:30") {
  const [hourText, minuteText] = String(timeText).split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const next = new Date();
  next.setHours(Number.isFinite(hour) ? hour : 21, Number.isFinite(minute) ? minute : 30, 0, 0);
  if (next.getTime() <= Date.now()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

async function runAutomatedDigest() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const state = stored[STORAGE_KEY] || {};
  const memories = state.memories || { blindSpots: [], notes: [], sessions: [] };
  const dailyMemories = filterRecentMemories(memories);

  if (!dailyMemories.sessions?.length && !dailyMemories.transcriptions?.length) return;

  const response = await fetch(`${SERVER_BASE}/api/digest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "自动整理今天的 AI 学习记录。",
      pageContext: null,
      memories: dailyMemories
    })
  });

  const data = await response.json();
  const noteText = data.answer || buildFallbackDigest(dailyMemories);
  const note = {
    title: "今日 LearnAlong AI 复盘",
    text: summarizeNote(noteText),
    fullText: noteText,
    source: "auto-digest",
    createdAt: new Date().toISOString(),
    readAt: null
  };

  const updated = {
    ...state,
    memories: {
      ...memories,
      notes: [...(memories.notes || []), note].slice(-80)
    },
    settings: {
      ...(state.settings || {}),
      lastDigestAt: note.createdAt
    }
  };

  await chrome.storage.local.set({ [STORAGE_KEY]: updated });
  chrome.action.setBadgeBackgroundColor({ color: "#1f7a61" });
  chrome.action.setBadgeText({ text: "学" });
}

function filterRecentMemories(memories) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return {
    ...memories,
    sessions: (memories.sessions || []).filter((item) => Date.parse(item.createdAt || "") >= cutoff),
    transcriptions: (memories.transcriptions || []).filter(
      (item) => Date.parse(item.createdAt || "") >= cutoff
    )
  };
}

function buildFallbackDigest(memories) {
  const sessions = (memories.sessions || []).slice(-5);
  const transcriptions = (memories.transcriptions || []).slice(-3);
  const sources = [
    ...sessions.map((session) => session.title).filter(Boolean),
    ...transcriptions.map((item) => item.title).filter(Boolean)
  ].slice(0, 3);
  return [
    "# 今日 LearnAlong AI 复盘",
    "",
    "## 今天学了什么",
    ...(sources.length ? sources.map((source) => `- ${source}`) : ["- 今天还没有足够多的学习来源。"]),
    "",
    "## 一句话总结",
    "今天的重点是把看到的 AI 信息转成自己的知识盲区和下一步练习。",
    "",
    "## 关键点",
    ...sessions.map((session) => `- 问过：${session.question}`),
    ...transcriptions.map((item) => `- 听过：${item.title}`),
    "",
    "## 仍然卡住的地方",
    ...(memories.blindSpots || []).slice(-6).map((spot) => `- ${spot}`),
    "",
    "## 对我有什么用",
    "这份记录能帮你判断 LearnAlong AI 是否真的降低了理解成本，而不是只多了一个聊天入口。",
    "",
    "## 今天的小实验",
    "选一个盲区，用“定义、例子、我能怎么用”三段写成自己的话。",
    "",
    "## 明天继续问",
    "这个概念和我的 LearnAlong AI 产品有什么关系？"
  ].join("\n");
}

function summarizeNote(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 4)
    .join("\n")
    .slice(0, 280);
}
