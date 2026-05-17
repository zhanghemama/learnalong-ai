const SERVER_BASE = "http://localhost:8787";

let recorder = null;
let chunks = [];
let mediaStream = null;
let audioContext = null;
let startedAt = null;
let sourceTab = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  if (message.type === "START_TAB_AUDIO_RECORDING") {
    startRecording(message.streamId, message.sourceTab)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "STOP_TAB_AUDIO_RECORDING") {
    stopRecording()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function startRecording(streamId, tab) {
  if (recorder?.state === "recording") {
    return { status: "already-recording" };
  }

  sourceTab = tab || null;
  startedAt = new Date().toISOString();
  chunks = [];

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);
  source.connect(audioContext.destination);

  recorder = new MediaRecorder(mediaStream, {
    mimeType: pickMimeType()
  });

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size) chunks.push(event.data);
  });

  recorder.start(1000);
  chrome.runtime.sendMessage({
    type: "TAB_TRANSCRIPTION_STATUS",
    status: "recording",
    sourceTab
  });

  return { status: "recording" };
}

async function stopRecording() {
  if (!recorder || recorder.state !== "recording") {
    return { status: "idle" };
  }

  const stoppedAt = new Date().toISOString();
  const blob = await new Promise((resolve, reject) => {
    recorder.addEventListener(
      "stop",
      () => resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" })),
      { once: true }
    );
    recorder.addEventListener("error", (event) => reject(event.error), { once: true });
    recorder.stop();
  });

  cleanupMedia();

  chrome.runtime.sendMessage({
    type: "TAB_TRANSCRIPTION_STATUS",
    status: "transcribing",
    sourceTab
  });

  const transcript = await transcribe(blob);
  const payload = {
    ...transcript,
    sourceTab,
    startedAt,
    stoppedAt,
    durationSeconds: estimateDurationSeconds(startedAt, stoppedAt)
  };

  chrome.runtime.sendMessage({
    type: "TAB_TRANSCRIPTION_COMPLETE",
    payload
  });

  return { status: "complete", payload };
}

function cleanupMedia() {
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  recorder = null;
  chunks = [];
  audioContext?.close();
  audioContext = null;
}

async function transcribe(blob) {
  const response = await fetch(`${SERVER_BASE}/api/transcribe`, {
    method: "POST",
    headers: {
      "Content-Type": blob.type || "audio/webm",
      "X-File-Name": "tab-audio.webm"
    },
    body: blob
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "转写失败");
  }
  return data;
}

function pickMimeType() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function estimateDurationSeconds(start, stop) {
  const started = Date.parse(start);
  const stopped = Date.parse(stop);
  if (!Number.isFinite(started) || !Number.isFinite(stopped)) return null;
  return Math.max(0, Math.round((stopped - started) / 1000));
}
