(() => {
  if (window.__learnAlongAiInjected) return;
  window.__learnAlongAiInjected = true;
  let lastSelectionText = "";
  let selectionTimer = null;
  let spacePushToTalkEnabled = false;
  let spacePushToTalkActive = false;
  let captionTrackCache = {
    key: "",
    result: null,
    promise: null
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SET_SPACE_PTT_ENABLED") {
      spacePushToTalkEnabled = Boolean(message.enabled);
      sendResponse({ ok: true, enabled: spacePushToTalkEnabled });
      return false;
    }
    if (message?.type === "PAUSE_ACTIVE_VIDEO") {
      sendResponse({ ok: true, ...pauseActiveVideo() });
      return false;
    }
    if (message?.type === "RESUME_ACTIVE_VIDEO") {
      resumeActiveVideo()
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      return true;
    }
    if (message?.type !== "EXTRACT_PAGE_CONTEXT") return false;
    extractPageContext()
      .then((context) => sendResponse({ ok: true, context }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return true;
  });

  document.addEventListener("selectionchange", scheduleSelectionUpdate);
  document.addEventListener("mouseup", scheduleSelectionUpdate);
  document.addEventListener("keyup", scheduleSelectionUpdate);
  document.addEventListener("keydown", handleSpacePushToTalkDown, true);
  document.addEventListener("keyup", handleSpacePushToTalkUp, true);

  async function extractPageContext() {
    const selectedText = cleanText(window.getSelection?.().toString() || "");
    const url = location.href;
    const host = location.hostname;
    const isX = /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host);
    const isYouTube = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host);

    const root = document.querySelector("article") || document.querySelector("main") || document.body;
    const tweets = isX ? extractTweets() : [];
    const youtubeContext = isYouTube ? await extractYouTubeContext() : null;
    const headings = [...document.querySelectorAll("h1,h2,h3")]
      .map((node) => cleanText(node.innerText))
      .filter(Boolean)
      .slice(0, 16);
    const pageText = tweets.length
      ? tweets.map((tweet) => tweet.text).join("\n\n")
      : isYouTube
        ? buildYouTubeText(root, youtubeContext)
        : cleanText(root?.innerText || "");

    return {
      title: youtubeContext?.title || document.title,
      url,
      site: host,
      contentType: isX ? "x-thread" : isYouTube ? "video-page" : "webpage",
      selectedText,
      headings,
      tweets,
      text: pageText,
      videoInfo: {
        ...(extractVideoInfo() || {}),
        ...(youtubeContext || {})
      },
      capturedAt: new Date().toISOString()
    };
  }

  function extractTweets() {
    const tweetNodes = [...document.querySelectorAll('[data-testid="tweet"]')].slice(0, 10);
    return tweetNodes
      .map((tweetNode) => {
        const text = [...tweetNode.querySelectorAll('[data-testid="tweetText"]')]
          .map((node) => cleanText(node.innerText))
          .filter(Boolean)
          .join("\n");
        const author = cleanText(tweetNode.querySelector('[data-testid="User-Name"]')?.innerText || "");
        return { author, text };
      })
      .filter((tweet) => tweet.text);
  }

  function handleSpacePushToTalkDown(event) {
    if (!spacePushToTalkEnabled || event.code !== "Space" || event.repeat || isEditableElement(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (spacePushToTalkActive) return;
    spacePushToTalkActive = true;
    chrome.runtime.sendMessage({ type: "VOICE_PTT_START", source: "page-space" });
  }

  function handleSpacePushToTalkUp(event) {
    if (!spacePushToTalkEnabled || event.code !== "Space" || isEditableElement(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!spacePushToTalkActive) return;
    spacePushToTalkActive = false;
    chrome.runtime.sendMessage({ type: "VOICE_PTT_STOP", source: "page-space" });
  }

  function isEditableElement(target) {
    const element = target instanceof Element ? target : null;
    if (!element) return false;
    return Boolean(element.closest("input, textarea, select, [contenteditable='true']"));
  }

  function extractVideoInfo() {
    const video = document.querySelector("video");
    if (!video) return null;
    return {
      hasVideo: true,
      currentTime: Number.isFinite(video.currentTime) ? Math.round(video.currentTime) : 0,
      duration: Number.isFinite(video.duration) ? Math.round(video.duration) : null,
      paused: video.paused,
      muted: video.muted,
      source: video.currentSrc || video.src || null
    };
  }

  function pauseActiveVideo() {
    const video = document.querySelector("video");
    if (!video) {
      return {
        hasVideo: false,
        paused: false,
        currentTime: null
      };
    }
    const wasPaused = video.paused;
    video.pause();
    return {
      hasVideo: true,
      wasPaused,
      paused: video.paused,
      currentTime: Number.isFinite(video.currentTime) ? Math.round(video.currentTime) : null
    };
  }

  async function resumeActiveVideo() {
    const video = document.querySelector("video");
    if (!video) {
      return {
        hasVideo: false,
        played: false,
        currentTime: null
      };
    }
    if (!video.paused) {
      return {
        hasVideo: true,
        played: false,
        currentTime: Number.isFinite(video.currentTime) ? Math.round(video.currentTime) : null
      };
    }
    await video.play();
    return {
      hasVideo: true,
      played: true,
      currentTime: Number.isFinite(video.currentTime) ? Math.round(video.currentTime) : null
    };
  }

  async function extractYouTubeContext() {
    const video = document.querySelector("video");
    const currentTime = video && Number.isFinite(video.currentTime) ? Math.round(video.currentTime) : null;
    const title = cleanText(
      document.querySelector("ytd-watch-metadata h1 yt-formatted-string")?.innerText ||
        document.querySelector("h1.ytd-watch-metadata")?.innerText ||
        document.querySelector("h1")?.innerText ||
        document.title
    );
    const description = cleanText(
      document.querySelector("#description-inline-expander")?.innerText ||
        document.querySelector("#description")?.innerText ||
        ""
    ).slice(0, 4000);
    const captions = [...document.querySelectorAll(".ytp-caption-segment")]
      .map((node) => cleanText(node.innerText))
      .filter(Boolean)
      .join(" ");
    const visibleTranscriptSegments = extractTranscriptSegments();
    const fetchedCaption = visibleTranscriptSegments.length
      ? { segments: visibleTranscriptSegments, label: "YouTube Transcript 面板", source: "visible-transcript" }
      : await fetchCaptionTrackSegments();
    const transcriptSegments = fetchedCaption.segments;
    const transcript = transcriptSegments
      .slice(0, 520)
      .map((segment) => `${segment.timeText} ${segment.text}`)
      .join("\n");
    const recentTranscript = pickTranscriptWindow(transcriptSegments, currentTime, 90, 8);
    const contextTranscript = pickTranscriptWindow(transcriptSegments, currentTime, 180, 20);
    const nearbyTranscript = pickTranscriptWindow(transcriptSegments, currentTime, 45, 12);

    return {
      title,
      description,
      captions: cleanText(captions),
      transcript: cleanText(transcript),
      nearbyTranscript,
      recentTranscript,
      contextTranscript,
      transcriptSource: fetchedCaption.source,
      transcriptTrackLabel: fetchedCaption.label,
      transcriptSegments: transcriptSegments.slice(0, 520)
    };
  }

  async function fetchCaptionTrackSegments() {
    try {
      const tracks = extractCaptionTracks();
      const track = pickCaptionTrack(tracks);
      if (!track?.baseUrl) return { segments: [], label: "", source: "none" };
      const url = new URL(track.baseUrl);
      url.searchParams.set("fmt", "json3");
      const cacheKey = url.toString();
      if (captionTrackCache.key === cacheKey && captionTrackCache.result) {
        return captionTrackCache.result;
      }
      if (captionTrackCache.key === cacheKey && captionTrackCache.promise) {
        return await captionTrackCache.promise;
      }

      captionTrackCache = {
        key: cacheKey,
        result: null,
        promise: fetchCaptionTrack(url.toString(), track)
      };
      const result = await captionTrackCache.promise;
      captionTrackCache =
        result.source === "caption-track-error"
          ? { key: "", result: null, promise: null }
          : { key: cacheKey, result, promise: null };
      return result;
    } catch (_error) {
      return { segments: [], label: "", source: "caption-track-error" };
    }
  }

  async function fetchCaptionTrack(url, track) {
    try {
      const response = await fetch(url.toString(), { credentials: "include" });
      if (!response.ok) return { segments: [], label: trackLabel(track), source: "caption-track-error" };
      const payload = await response.text();
      return {
        segments: parseCaptionPayload(payload),
        label: trackLabel(track),
        source: "caption-track"
      };
    } catch (_error) {
      return { segments: [], label: "", source: "caption-track-error" };
    }
  }

  function extractCaptionTracks() {
    const response = extractInitialPlayerResponse();
    return response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  }

  function pickCaptionTrack(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) return null;
    return (
      tracks.find((track) => track.languageCode === "zh" || track.languageCode === "zh-Hans") ||
      tracks.find((track) => track.languageCode === "en" && track.kind !== "asr") ||
      tracks.find((track) => track.languageCode === "en") ||
      tracks.find((track) => /English/i.test(trackLabel(track))) ||
      tracks[0]
    );
  }

  function trackLabel(track) {
    return cleanText(track?.name?.simpleText || track?.name?.runs?.map((run) => run.text).join("") || track?.languageCode || "");
  }

  function extractInitialPlayerResponse() {
    const scripts = [...document.scripts].map((script) => script.textContent || "");
    for (const text of scripts) {
      const markerIndex = text.indexOf("ytInitialPlayerResponse");
      if (markerIndex === -1) continue;
      const equalsIndex = text.indexOf("=", markerIndex);
      const jsonStart = text.indexOf("{", equalsIndex);
      if (jsonStart === -1) continue;
      const json = extractBalancedJson(text, jsonStart);
      if (!json) continue;
      try {
        return JSON.parse(json);
      } catch (_error) {
        continue;
      }
    }
    return null;
  }

  function extractBalancedJson(text, startIndex) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = startIndex; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(startIndex, index + 1);
      }
    }
    return "";
  }

  function parseCaptionPayload(payload) {
    try {
      return parseJsonCaption(JSON.parse(payload));
    } catch (_error) {
      return parseXmlCaption(payload);
    }
  }

  function parseJsonCaption(data) {
    const events = Array.isArray(data.events) ? data.events : [];
    return events
      .map((event) => {
        const text = cleanText((event.segs || []).map((segment) => segment.utf8 || "").join(""));
        const timeSeconds = Number.isFinite(event.tStartMs) ? Math.round(event.tStartMs / 1000) : null;
        return {
          timeText: formatCaptionTime(timeSeconds),
          timeSeconds,
          text
        };
      })
      .filter((segment) => segment.text);
  }

  function parseXmlCaption(payload) {
    const documentXml = new DOMParser().parseFromString(payload, "text/xml");
    return [...documentXml.querySelectorAll("text")]
      .map((node) => {
        const timeSeconds = Math.round(Number(node.getAttribute("start") || 0));
        return {
          timeText: formatCaptionTime(timeSeconds),
          timeSeconds,
          text: cleanText(node.textContent || "")
        };
      })
      .filter((segment) => segment.text);
  }

  function formatCaptionTime(seconds) {
    if (!Number.isFinite(seconds)) return "";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
      : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  function extractTranscriptSegments() {
    return [...document.querySelectorAll("ytd-transcript-segment-renderer")]
      .map((node) => {
        const lines = cleanText(node.innerText)
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const timeText = lines.find((line) => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(line)) || "";
        const text = lines.filter((line) => line !== timeText).join(" ");
        return {
          timeText,
          timeSeconds: parseTimeText(timeText),
          text
        };
      })
      .filter((segment) => segment.text);
  }

  function pickTranscriptWindow(segments, currentTime, secondsBefore, secondsAfter) {
    if (!segments.length || currentTime === null) return "";
    const nearby = segments.filter((segment) => {
      if (!Number.isFinite(segment.timeSeconds)) return false;
      return segment.timeSeconds >= currentTime - secondsBefore && segment.timeSeconds <= currentTime + secondsAfter;
    });
    const fallback = nearby.length ? nearby : segments.filter((segment) => segment.timeSeconds <= currentTime).slice(-18);
    return cleanText(fallback.map((segment) => `${segment.timeText} ${segment.text}`).join("\n"));
  }

  function parseTimeText(timeText) {
    const parts = String(timeText || "")
      .split(":")
      .map((part) => Number(part));
    if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function buildYouTubeText(root, youtubeContext) {
    const parts = [
      youtubeContext?.title ? `视频标题：${youtubeContext.title}` : "",
      youtubeContext?.description ? `视频描述：${youtubeContext.description}` : "",
      youtubeContext?.captions ? `当前可见字幕：${youtubeContext.captions}` : "",
      youtubeContext?.transcriptTrackLabel ? `字幕轨道：${youtubeContext.transcriptTrackLabel}` : "",
      youtubeContext?.recentTranscript ? `发问前约 90 秒 transcript：\n${youtubeContext.recentTranscript}` : "",
      youtubeContext?.nearbyTranscript ? `当前播放点附近 transcript：\n${youtubeContext.nearbyTranscript}` : "",
      youtubeContext?.transcript ? `Transcript：\n${youtubeContext.transcript}` : "",
      cleanText(root?.innerText || "").slice(0, 12000)
    ].filter(Boolean);
    return cleanText(parts.join("\n\n"));
  }

  function scheduleSelectionUpdate() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(sendSelectionUpdate, 180);
  }

  function sendSelectionUpdate() {
    const selectedText = cleanText(window.getSelection?.().toString() || "");
    if (selectedText === lastSelectionText) return;
    lastSelectionText = selectedText;
    chrome.runtime.sendMessage({
      type: "PAGE_SELECTION_CHANGED",
      selectedText,
      selectedTextLength: selectedText.length,
      url: location.href
    });
  }

  function cleanText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
      .slice(0, 24000);
  }
})();
