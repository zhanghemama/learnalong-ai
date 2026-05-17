import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

loadDotEnv();

const ROOT_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MOBILE_DIR = join(ROOT_DIR, "mobile");
const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-5.4-mini";
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2";
const OPENAI_REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "marin";
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
const OPENAI_BASE_URL = normalizeBaseUrl(process.env.OPENAI_BASE_URL || "https://api.openai.com");
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

const TUTOR_SYSTEM_PROMPT = `
You are "LearnAlong AI", a Chinese voice-first learning companion for people studying AI.
Help the learner understand what they are reading or watching without adding extra product workflow.

Rules:
- Reply in concise Chinese.
- Preserve important English technical terms such as agent, MCP, evals, Realtime API, RAG, tool use, workspace agent.
- For technical topics, prefer: 一句话说明 -> 关键解释 -> 为什么重要.
- Do not proactively output knowledge blind spots, practice tasks, learning plans, or product advice unless the user asks for them.
- If page context is thin, say what is missing and give the best explanation from available text.
`;

const DIGEST_SYSTEM_PROMPT = `
You are "LearnAlong AI" writing a daily Chinese learning review for one user.
The note must be readable, skimmable, and useful for tomorrow's practice. Do not produce a generic recap.

Use this exact Markdown structure:

# 今日 LearnAlong AI 复盘

## 今天学了什么
- List up to 3 source topics, pages, videos, or questions.

## 一句话总结
One plain Chinese sentence.

## 关键点
- 3 to 5 bullets. Preserve key English terms such as agent, MCP, evals, Realtime API, RAG, WebRTC, workspace agent.

## 仍然卡住的地方
- List concrete blind spots. If none are clear, infer cautiously.

## 对我有什么用
Explain how this helps the user's AI study or product building.

## 今天的小实验
One practice task that can be done in 15-30 minutes.

## 明天继续问
One reusable prompt the user can ask tomorrow.

Rules:
- Keep it short enough to read in 3-5 minutes.
- Separate signal from noise.
- Use simple Chinese, not academic prose.
- Never invent source details not present in the input.
`;

const VIDEO_SUMMARY_SYSTEM_PROMPT = `
你是一个中文 YouTube 视频内容介绍助手。用户把一个 YouTube 链接交给你，希望你像真实看过字幕一样，讲清楚这个视频到底在讲什么。

输出要求：
- 只输出自然中文的视频内容介绍，不要展示或解释内部 prompt。
- 如果提供了字幕、transcript 或逐字稿，必须基于这些真实内容总结，不要只根据标题猜测。
- 如果只提供了标题和简介，开头必须明确说“我目前只读到标题和简介”，然后给出有限上下文下的判断。
- 不要围绕“LearnAlong AI”产品展开，除非视频本身就在讲这个产品。
- 不要输出知识盲点、练习任务、学习建议、产品建议。
- 保留必要的英文技术词，如 agent, prompt, tool use, MCP, Claude Code, evals。

格式：
1. 先写一段 4-6 句话的整体介绍，像在回答“这个视频主要讲什么？”。
2. 再用“主要内容：”列出 3-5 个要点。
3. 要点必须来自视频内容本身。
`;

const LEARNING_PAGE_SYSTEM_PROMPT = `
You create a polished, shareable learning article from a user's current study session.
The frontend will render your output as an HTML document, so return strict JSON only. Do not wrap it in markdown fences.

Rules:
- Use the requested language. For bilingual output, use Chinese explanations and keep important English terms.
- Base the document on real inputs: transcript timeline, page text, user questions, assistant answers, and notes.
- Do not invent video details that are not present in the input.
- Write like a thoughtful article someone could share after watching the video, not like private notes or a dashboard.
- Prefer a strong headline, a clear lead, readable sections, and concrete examples from the transcript.
- At the bottom, include study notes distilled from the learner's own questions if any questions are provided.
- If transcript context is limited, say that in the subtitle or first overview paragraph.
- Keep technical terms such as agent, MCP, evals, Realtime API, RAG, tool use in English when useful.

Return this JSON shape:
{
  "title": "shareable article headline",
  "subtitle": "article dek or one-sentence promise",
  "overview": ["2-4 lead paragraphs that introduce the video's main idea"],
  "keyPoints": [{"title": "section heading", "body": "article-style section paragraph"}],
  "timeline": [{"time": "0:00", "title": "notable moment", "body": "what this moment adds to the article"}],
  "glossary": [{"term": "technical term", "explanation": "plain explanation"}],
  "qa": [{"question": "learner question as the note title", "answer": "study note distilled from that question and answer", "time": "optional video time"}],
  "review": ["3-5 shareable takeaways"]
}
`;

const REALTIME_INSTRUCTIONS = `
你是“LearnAlong AI”的实时语音导师。用户正在浏览网页、X 帖子、文档或视频。
你会收到当前页面上下文。短句优先，允许用户随时打断。

目标：
1. 用户问“这是什么/在讲什么”时，解释当前页面或视频内容。
2. 用户问“刚才说什么”“这里在讲什么”“这段什么意思”时，优先结合发问瞬间提供的 video.timeline（本地跟读时间线）和 video.rollingTranscript，再结合 video.recentTranscript（发问前约 90 秒）和 video.contextTranscript（发问前约 3 分钟），最后参考 currentTime、captions、nearbyTranscript。
3. 用户问“这个视频整体讲什么”时，基于可用字幕、transcript、标题和简介给出整体介绍。
4. 不要主动输出知识盲点、练习任务或学习计划，除非用户明确要求。
5. 当用户说“记一下”“帮我保存”“加入笔记”“把刚才那段记下来”时，调用 save_learning_note。
6. 当用户说“这是我的盲区”“我不懂这个”“加入知识盲区”时，调用 save_blind_spot。

风格：
- 温暖、清楚、像一起学习的同伴。
- 不要装作看到了上下文中没有的信息。
- 技术词保留英文，如 agent, MCP, evals, Realtime API, RAG, tool use。
`;

function realtimeInstructionsForLanguage(language = "en") {
  const languageRule =
    language === "zh"
      ? "默认用中文回答；如果用户明确用英文提问，则用英文回答。"
      : language === "bilingual"
        ? "默认中文解释为主，关键术语保留英文；如果用户明确用英文提问，则用英文回答。"
        : "Default to English. If the user asks in English, answer in English. If the user asks in Chinese, answer in Chinese.";
  return `${REALTIME_INSTRUCTIONS}\n\n语言规则：\n${languageRule}\n优先跟随用户刚才实际说话的语言，其次参考当前 UI language。`;
}

const REALTIME_TOOLS = [
  {
    type: "function",
    name: "save_learning_note",
    description:
      "Save a concise learning note when the user explicitly asks to remember, save, or add something to notes. Use this for phrases like 记一下, 保存一下, 加入笔记, 把刚才那段记下来.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title for the note. Match the user's language."
        },
        content: {
          type: "string",
          description:
            "The note content. Match the user's language. Prefer the latest explanation or the specific concept the user asked to remember."
        },
        reason: {
          type: "string",
          description: "Optional reason why the user wanted to save it."
        }
      },
      required: ["title", "content"]
    }
  },
  {
    type: "function",
    name: "save_blind_spot",
    description:
      "Save a knowledge blind spot when the user explicitly says they do not understand a concept or asks to add it to blind spots.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The concrete concept or term the user does not understand."
        },
        reason: {
          type: "string",
          description: "Why this is a blind spot, if clear from the conversation."
        },
        priority: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "How important this blind spot seems for the current learning context."
        }
      },
      required: ["topic"]
    }
  }
];

function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  });
  res.end(body);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function normalizeBaseUrl(value) {
  return String(value || "https://api.openai.com").replace(/\/+$/, "");
}

function openAIUrl(path) {
  return `${OPENAI_BASE_URL}${path}`;
}

function openAIWebSocketUrl(path, params = {}) {
  const url = new URL(openAIUrl(path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function contentTypeFor(filePath) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8"
  };
  return types[extname(filePath)] || "application/octet-stream";
}

async function serveMobileAsset(pathname, res) {
  const normalizedPath = normalize(pathname.replace(/^\/mobile\/?/, ""));
  const relativePath = !normalizedPath || normalizedPath === "." ? "index.html" : normalizedPath;
  const filePath = resolve(MOBILE_DIR, relativePath);

  if (!filePath.startsWith(MOBILE_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return true;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    const body = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": "no-store"
    });
    res.end(body);
    return true;
  } catch (_error) {
    sendJson(res, 404, { error: "Mobile asset not found" });
    return true;
  }
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function readBuffer(req, maxBytes = MAX_AUDIO_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error(`Audio is too large. Keep clips under ${Math.round(maxBytes / 1024 / 1024)}MB.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function trimText(value, max = 16000) {
  if (!value) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function trimMultiline(value, max = 26000) {
  if (!value) return "";
  const text = String(value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function normalizeLanguage(value) {
  return ["zh", "en", "bilingual"].includes(value) ? value : "en";
}

function summarizeContext(pageContext = {}) {
  const tweets = Array.isArray(pageContext.tweets)
    ? pageContext.tweets.map((tweet, index) => `${index + 1}. ${trimText(tweet.text, 900)}`).join("\n")
    : "";

  return {
    title: pageContext.title || "",
    url: pageContext.url || "",
    site: pageContext.site || "",
    contentType: pageContext.contentType || "webpage",
    selectedText: trimText(pageContext.selectedText, 4000),
    headings: Array.isArray(pageContext.headings) ? pageContext.headings.slice(0, 12) : [],
    tweets,
    videoInfo: pageContext.videoInfo || null,
    pageText: trimMultiline(pageContext.text, 26000)
  };
}

function offlineTutorResponse(payload) {
  const context = summarizeContext(payload.pageContext);
  const question = trimText(payload.question, 800);
  const source = context.selectedText || context.tweets || context.pageText || context.title || "当前页面内容不足";
  const excerpt = trimText(source, 900);

  return {
    mode: "offline",
    answer: [
      "我现在用离线草稿先陪你拆一下，因为本地 server 没有检测到 `OPENAI_API_KEY`。",
      "",
      `你问的是：${question || "这页在讲什么？"}`,
      "",
      "一句话：这段内容需要先提取核心主张，再把里面的 AI 术语拆成可操作的概念。",
      "",
      `我能读到的上下文：${excerpt}`,
      "",
      "可能的知识盲区：",
      "- 这条内容里的关键 AI 术语",
      "- 作者真正想表达的产品或技术变化",
      "- 这件事能不能转化成自己的项目实践",
      "",
      "15 分钟小练习：把这页里最不懂的 1 个词加入盲区，然后让 LearnAlong AI 用“定义、例子、我能怎么用”三段解释。"
    ].join("\n"),
    blindSpots: ["关键 AI 术语", "产品实践关系", "技术变化判断"]
  };
}

function offlineDigestResponse(payload) {
  const memories = payload.memories || {};
  const sessions = Array.isArray(memories.sessions) ? memories.sessions.slice(-5) : [];
  const transcriptions = Array.isArray(memories.transcriptions) ? memories.transcriptions.slice(-3) : [];
  const blindSpots = Array.isArray(memories.blindSpots) ? memories.blindSpots.slice(-6) : [];
  const sources = [
    ...sessions.map((session) => session.title).filter(Boolean),
    ...transcriptions.map((item) => item.title).filter(Boolean)
  ].slice(0, 3);

  return {
    mode: "offline",
    answer: [
      "# 今日 LearnAlong AI 复盘",
      "",
      "## 今天学了什么",
      ...(sources.length ? sources.map((source) => `- ${source}`) : ["- 今天还没有足够多的学习来源。"]),
      "",
      "## 一句话总结",
      "今天的重点是把看到的 AI 信息转成自己的知识盲区和下一步练习。",
      "",
      "## 关键点",
      ...(sessions.length
        ? sessions.map((session) => `- 问过：${trimText(session.question, 140)}`)
        : ["- 还没有稳定的提问记录。"]),
      ...transcriptions.map((item) => `- 听过：${item.title}`),
      "",
      "## 仍然卡住的地方",
      ...(blindSpots.length ? blindSpots.map((spot) => `- ${spot}`) : ["- 暂时还没有沉淀出明确盲区。"]),
      "",
      "## 对我有什么用",
      "这份记录能帮你判断 LearnAlong AI 是否真的降低了理解成本，而不是只多了一个聊天入口。",
      "",
      "## 今天的小实验",
      "选一个盲区，用“定义、例子、我能怎么用”三段写成自己的话。",
      "",
      "## 明天继续问",
      "这个概念和我的 LearnAlong AI 产品有什么关系？"
    ].join("\n"),
    blindSpots
  };
}

function offlineLearningPageResponse(payload) {
  const context = summarizeContext(payload.pageContext);
  const language = payload.language === "en" ? "en" : payload.language === "bilingual" ? "bilingual" : "zh";
  const isEnglish = language === "en";
  const timeline = Array.isArray(payload.studyTimeline) ? payload.studyTimeline.slice(-8) : [];
  const questions = Array.isArray(payload.studyQuestions) ? payload.studyQuestions.slice(-6) : [];
  const title = context.title || (isEnglish ? "Current learning article" : "当前学习文章");
  const sourceText = trimText(context.videoInfo?.rollingTranscript || context.videoInfo?.recentTranscript || context.pageText, 1200);

  return {
    mode: "offline",
    document: {
      title: isEnglish ? `What this video is really about: ${title}` : `这支视频到底讲了什么：${title}`,
      subtitle: isEnglish
        ? "A local article draft generated from the readable context because OPENAI_API_KEY is not configured."
        : "本地文章草稿：未检测到 OPENAI_API_KEY，先基于已读取上下文生成。",
      overview: [
        isEnglish
          ? "This article draft is based on the current video/page context captured by LearnAlong AI."
          : "这篇文章草稿基于 LearnAlong AI 已跟读到的视频/页面上下文生成。",
        sourceText || (isEnglish ? "No readable transcript was found yet." : "当前还没有读到足够字幕或页面文本。")
      ],
      keyPoints: [
        {
          title: isEnglish ? "What can be said from the available context" : "从已读取上下文能看出的内容",
          body: sourceText || (isEnglish ? "Open subtitles or transcript for a richer article." : "打开字幕或 Transcript 后，可以生成更完整的学习文章。")
        }
      ],
      timeline: timeline.map((item) => ({
        time: item.time || "",
        title: isEnglish ? "Video moment" : "视频片段",
        body: item.text || ""
      })),
      glossary: [],
      qa: questions.map((item) => ({
        question: item.question || "",
        answer: item.answer || "",
        time: item.videoTime || ""
      })),
      review: [
        isEnglish ? "More captured transcript context will make the article more specific." : "跟读到的字幕越完整，文章会越具体。",
        isEnglish ? "Learner questions can become the clearest explanations for future readers." : "学习过程中的提问，可以变成后来读者最需要的解释。"
      ]
    },
    blindSpots: []
  };
}

function offlineVideoSummaryResponse(payload) {
  const context = summarizeContext(payload.pageContext);
  const videoInfo = context.videoInfo || {};
  const source = trimMultiline(videoInfo.transcript || context.pageText || context.title, 1200);

  return {
    mode: "offline",
    answer: [
      "我现在用离线草稿先生成一个有限版本，因为本地 server 没有检测到 `OPENAI_API_KEY`。",
      "",
      source
        ? `我目前能读到的内容是：${source}`
        : "我目前还没有读到字幕、transcript 或页面文字，所以不能可靠介绍这个视频内容。",
      "",
      "主要内容：",
      "- 设置 API key 后，这里会基于 YouTube 字幕或页面 transcript 生成完整视频介绍。",
      "- 如果链接字幕读取不到，会继续尝试使用当前页面里的 Transcript。",
      "- 如果仍然没有字幕，才会退回到标题和简介。"
    ].join("\n"),
    blindSpots: []
  };
}

function offlineTranscriptionResponse(buffer) {
  return {
    mode: "offline",
    text: [
      "本地 server 没有检测到 `OPENAI_API_KEY`，所以这里还不能真实转写音频。",
      `已经收到一段约 ${Math.round(buffer.length / 1024)}KB 的标签页音频。`,
      "设置 API key 后，这里会返回视频/音频 transcript，并自动加入学习记录。"
    ].join("\n")
  };
}

function extractOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  if (!Array.isArray(data.output)) return "";
  return data.output
    .flatMap((item) => item.content || [])
    .map((part) => part.text || part.output_text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseModelJsonObject(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(raw);
  } catch (_error) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (_innerError) {
      return null;
    }
  }
}

async function callOpenAIResponses(payload, task = "chat") {
  if (!OPENAI_API_KEY) {
    if (task === "digest") return offlineDigestResponse(payload);
    if (task === "youtube-summary") return offlineVideoSummaryResponse(payload);
    if (task === "learning-page") return offlineLearningPageResponse(payload);
    return offlineTutorResponse(payload);
  }

  const context = summarizeContext(payload.pageContext);
  const userMemory = payload.memories || {};
  const systemPrompt =
    task === "digest"
      ? DIGEST_SYSTEM_PROMPT
      : task === "youtube-summary"
        ? VIDEO_SUMMARY_SYSTEM_PROMPT
        : task === "learning-page"
          ? LEARNING_PAGE_SYSTEM_PROMPT
          : TUTOR_SYSTEM_PROMPT;
  const expectedOutput =
    task === "digest"
      ? [
          "生成一份短而易读的今日学习复盘。",
          "必须使用 DIGEST_SYSTEM_PROMPT 指定的 Markdown 结构。",
          "优先整理用户真正问过、听过、标记过盲区的内容。",
          "不要写泛泛的新闻总结。"
        ].join("\n")
      : task === "youtube-summary"
        ? [
            "生成一份视频内容介绍。",
            "先写 4-6 句话整体介绍，再列 3-5 个主要内容点。",
            "不要输出知识盲点、练习任务、学习建议或产品建议。",
            "不要提及内部 prompt。"
          ].join("\n")
        : task === "learning-page"
          ? [
              "生成一篇适合渲染为 HTML、可以分享给别人阅读的学习文章 JSON。",
              "必须返回 strict JSON object，不要 markdown fence，不要额外解释。",
              "优先使用 video.timeline、video.rollingTranscript、recentTranscript、contextTranscript、用户语音问答记录和保存的笔记。",
              "文章要有标题、导语、正文小节、值得记住的时刻和结尾要点。",
              "如果用户问过问题，请在 qa 字段把这些问题整理成文章底部的学习笔记，不要只是复刻聊天记录。",
              "如果字幕上下文不足，请在 subtitle 或 overview 开头说明信息有限。"
            ].join("\n")
          : "回答用户问题。不要自动输出知识盲点、练习任务或学习计划。";
  const input = [
    {
      role: "system",
      content: [{ type: "input_text", text: systemPrompt }]
    },
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: JSON.stringify(
            {
              task,
              question: payload.question,
              language: payload.language || "zh",
              pageContext: context,
              knownBlindSpots: userMemory.blindSpots || [],
              savedNotes: userMemory.notes || [],
              transcriptions: userMemory.transcriptions || [],
              studyTimeline: payload.studyTimeline || [],
              studyQuestions: payload.studyQuestions || [],
              studyNotes: payload.studyNotes || [],
              expectedOutput
            },
            null,
            2
          )
        }
      ]
    }
  ];

  const response = await fetch(openAIUrl("/v1/responses"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_TEXT_MODEL,
      input
    })
  });

  const data = await response.json();
  if (!response.ok) {
    return {
      mode: "error",
      answer: `OpenAI 请求失败：${data.error?.message || response.statusText}`,
      blindSpots: []
    };
  }

  const answer = extractOutputText(data) || "我没有拿到可读输出。";
  return {
    mode: "openai",
    answer,
    ...(task === "learning-page" ? { document: parseModelJsonObject(answer) } : {}),
    blindSpots: []
  };
}

async function summarizeYouTubeFromLink(payload) {
  const youtubeUrl = normalizeYouTubeUrl(payload.url || payload.pageContext?.url || "");
  if (!youtubeUrl) {
    return {
      error: "请在 YouTube 视频页使用，或者传入有效的 YouTube 链接。"
    };
  }

  const fallbackContext = payload.pageContext || {};
  let linkContext = {
    title: "",
    description: "",
    captionTrackLabel: "",
    transcriptText: "",
    transcriptSource: "none",
    transcriptSegmentCount: 0
  };
  let linkError = "";

  try {
    linkContext = await extractYouTubeLinkContext(youtubeUrl);
  } catch (error) {
    linkError = error instanceof Error ? error.message : String(error);
  }

  const layeredSource = pickVideoSummarySource({ linkContext, fallbackContext });
  const hasTranscript = ["link-caption-track", "page-transcript"].includes(layeredSource.source);
  const pageContext = {
    ...fallbackContext,
    title: linkContext.title || fallbackContext.title || "YouTube 视频",
    url: youtubeUrl,
    site: "youtube.com",
    contentType: "video-page",
    text: trimMultiline(
      [
        `视频标题：${linkContext.title || fallbackContext.title || ""}`,
        linkContext.description ? `视频简介：${linkContext.description}` : "",
        layeredSource.trackLabel ? `字幕轨道：${layeredSource.trackLabel}` : "",
        layeredSource.text ? `${layeredSource.heading}：\n${layeredSource.text}` : "",
        linkError ? `链接字幕读取错误：${linkError}` : ""
      ]
        .filter(Boolean)
        .join("\n\n"),
      30000
    ),
    videoInfo: {
      ...(fallbackContext.videoInfo || {}),
      transcript: layeredSource.source === "link-caption-track" || layeredSource.source === "page-transcript" ? layeredSource.text : "",
      transcriptSource: layeredSource.source,
      transcriptTrackLabel: layeredSource.trackLabel,
      transcriptSegmentCount: layeredSource.segmentCount
    }
  };

  const question = hasTranscript
    ? [
        "请基于 YouTube 链接读取到的真实字幕内容，介绍这个视频讲了什么。",
        "",
        "写法像把一个 YouTube link 发给你，让你给我讲下这个视频是什么内容。",
        "先用 4-6 句话自然介绍视频内容，再列 3-5 个主要内容点。",
        "不要说只读到标题/简介；只有字幕为空时才说明信息不足。"
      ].join("\n")
    : [
        "请介绍这个 YouTube 视频讲了什么。",
        "",
        `当前内容来源层级是：${layeredSource.label}。`,
        layeredSource.source === "title-description"
          ? "你只能基于标题和简介判断，必须明确说明“我目前只读到标题和简介”。"
          : "请基于已有页面内容介绍视频，不要假装读到了完整字幕。"
      ].join("\n");

  const result = await callOpenAIResponses(
    {
      ...payload,
      question,
      pageContext
    },
    "youtube-summary"
  );

  return {
    ...result,
    source: layeredSource.source,
    sourceLabel: layeredSource.label,
    title: pageContext.title,
    url: youtubeUrl,
    transcriptAvailable: hasTranscript,
    transcriptSegmentCount: layeredSource.segmentCount,
    captionTrackLabel: layeredSource.trackLabel,
    linkError
  };
}

function pickVideoSummarySource({ linkContext, fallbackContext }) {
  const videoInfo = fallbackContext.videoInfo || {};
  const linkTranscript = trimMultiline(linkContext.transcriptText, 32000);
  if (linkTranscript) {
    return {
      source: "link-caption-track",
      label: "YouTube 链接字幕轨道",
      heading: "字幕内容",
      text: linkTranscript,
      trackLabel: linkContext.captionTrackLabel || "",
      segmentCount: linkContext.transcriptSegmentCount || 0
    };
  }

  const pageTranscript = trimMultiline(videoInfo.transcript, 30000);
  if (pageTranscript) {
    return {
      source: "page-transcript",
      label: "当前页面 Transcript",
      heading: "字幕内容",
      text: pageTranscript,
      trackLabel: videoInfo.transcriptTrackLabel || "",
      segmentCount: Array.isArray(videoInfo.transcriptSegments) ? videoInfo.transcriptSegments.length : 0
    };
  }

  const visibleCaptions = trimMultiline([videoInfo.nearbyTranscript, videoInfo.captions].filter(Boolean).join("\n\n"), 9000);
  if (visibleCaptions) {
    return {
      source: "page-captions",
      label: "当前页面可见字幕",
      heading: "可见字幕",
      text: visibleCaptions,
      trackLabel: videoInfo.transcriptTrackLabel || "",
      segmentCount: 0
    };
  }

  const pageText = trimMultiline(fallbackContext.text, 16000);
  if (pageText) {
    return {
      source: "page-context",
      label: "当前页面文字",
      heading: "页面文字",
      text: pageText,
      trackLabel: "",
      segmentCount: 0
    };
  }

  return {
    source: "title-description",
    label: "标题和简介",
    heading: "标题和简介",
    text: trimMultiline(
      [`视频标题：${linkContext.title || fallbackContext.title || ""}`, linkContext.description || ""]
        .filter(Boolean)
        .join("\n\n"),
      6000
    ),
    trackLabel: "",
    segmentCount: 0
  };
}

function normalizeYouTubeUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : "";
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      const id = parsed.searchParams.get("v");
      return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : parsed.toString();
    }
  } catch (_error) {
    return "";
  }
  return "";
}

async function extractYouTubeLinkContext(youtubeUrl) {
  const html = await fetchText(youtubeUrl, {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7"
  });
  const playerResponse = extractInitialPlayerResponseFromHtml(html);
  const title = playerResponse?.videoDetails?.title || extractMetaContent(html, "title") || "";
  const description = playerResponse?.videoDetails?.shortDescription || extractMetaContent(html, "description") || "";
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const track = pickCaptionTrack(tracks);
  const captionSegments = track?.baseUrl ? await fetchCaptionSegments(track.baseUrl) : [];

  return {
    title: trimText(title, 300),
    description: trimMultiline(description, 5000),
    captionTrackLabel: trackLabel(track),
    transcriptText: trimMultiline(
      captionSegments.map((segment) => `${segment.timeText} ${segment.text}`).join("\n"),
      32000
    ),
    transcriptSource: track?.baseUrl ? "server-caption-track" : "none",
    transcriptSegmentCount: captionSegments.length
  };
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`读取链接失败：${response.status} ${response.statusText}`);
  }
  return await response.text();
}

function extractMetaContent(html, name) {
  const pattern = new RegExp(`<meta[^>]+(?:name|property)=["'](?:og:)?${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["']`, "i");
  const match = html.match(pattern);
  return match ? decodeHtml(match[1]) : "";
}

function extractInitialPlayerResponseFromHtml(html) {
  const markerIndex = html.indexOf("ytInitialPlayerResponse");
  if (markerIndex === -1) return null;
  const equalsIndex = html.indexOf("=", markerIndex);
  const jsonStart = html.indexOf("{", equalsIndex);
  if (jsonStart === -1) return null;
  const json = extractBalancedJson(html, jsonStart);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (_error) {
    return null;
  }
}

function extractBalancedJson(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return "";
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
  if (!track) return "";
  return trimText(
    track.name?.simpleText || (Array.isArray(track.name?.runs) ? track.name.runs.map((run) => run.text).join("") : "") || track.languageCode || "",
    120
  );
}

async function fetchCaptionSegments(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set("fmt", "json3");
  const payload = await fetchText(url.toString(), {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7"
  });
  return parseCaptionPayload(payload);
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
      const text = trimText((event.segs || []).map((segment) => segment.utf8 || "").join(" "), 1000);
      const timeSeconds = Number.isFinite(event.tStartMs) ? Math.round(event.tStartMs / 1000) : null;
      return { timeText: formatCaptionTime(timeSeconds), timeSeconds, text };
    })
    .filter((segment) => segment.text);
}

function parseXmlCaption(payload) {
  return [...payload.matchAll(/<text[^>]*start="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g)]
    .map((match) => {
      const timeSeconds = Math.round(Number(match[1]));
      return {
        timeText: formatCaptionTime(timeSeconds),
        timeSeconds,
        text: trimText(decodeHtml(match[2]), 1000)
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

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function transcribeAudio(req) {
  const buffer = await readBuffer(req);
  const contentType = req.headers["content-type"] || "audio/webm";
  const fileName = req.headers["x-file-name"] || "tab-audio.webm";

  if (!buffer.length) {
    return { error: "Empty audio payload." };
  }

  if (!OPENAI_API_KEY) {
    return offlineTranscriptionResponse(buffer);
  }

  const form = new FormData();
  form.set("model", OPENAI_TRANSCRIBE_MODEL);
  form.set(
    "prompt",
    "The audio is about AI, OpenAI, ChatGPT, Codex, agents, workspace agents, MCP, evals, RAG, Realtime API, WebRTC, and developer tools."
  );
  form.set("file", new Blob([buffer], { type: contentType }), fileName);

  const response = await fetch(openAIUrl("/v1/audio/transcriptions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: form
  });

  const data = await response.json();
  if (!response.ok) {
    return {
      error: data.error?.message || "Transcription failed.",
      raw: data
    };
  }

  return {
    mode: "openai",
    model: OPENAI_TRANSCRIBE_MODEL,
    text: data.text || "",
    raw: data
  };
}

async function createRealtimeToken(payload) {
  if (!OPENAI_API_KEY) {
    return {
      error: "Missing OPENAI_API_KEY. Set it before starting a realtime voice session."
    };
  }

  const safetySeed = payload?.profileId || "local-learnalong-ai";
  const safetyIdentifier = createHash("sha256").update(String(safetySeed)).digest("hex");
  const language = normalizeLanguage(payload?.language || payload?.uiLanguage);

  const response = await fetch(openAIUrl("/v1/realtime/client_secrets"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": safetyIdentifier
    },
    body: JSON.stringify({
      expires_after: {
        anchor: "created_at",
        seconds: 600
      },
      session: {
        type: "realtime",
        model: OPENAI_REALTIME_MODEL,
        instructions: realtimeInstructionsForLanguage(language),
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: 24000
            },
            turn_detection: null,
            transcription: {
              model: OPENAI_TRANSCRIBE_MODEL,
              prompt:
                language === "en"
                  ? "The user may ask in English, with AI terms such as agent, MCP, evals, Realtime API, RAG, tool use. They may occasionally speak Chinese."
                  : "用户可能用中文或英文提问，可能夹杂 agent, MCP, evals, Realtime API, RAG, tool use 等英文 AI 术语。"
            }
          },
          output: {
            format: {
              type: "audio/pcm",
              rate: 24000
            },
            voice: OPENAI_REALTIME_VOICE
          }
        },
        tools: REALTIME_TOOLS,
        tool_choice: "auto",
        truncation: "auto"
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    return {
      error: data.error?.message || "Failed to create realtime client secret.",
      raw: data
    };
  }
  return {
    ...data,
    realtimeUrl: openAIUrl("/v1/realtime/calls"),
    realtimeWsUrl: openAIWebSocketUrl("/v1/realtime", { model: OPENAI_REALTIME_MODEL })
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(302, { Location: "/mobile/" });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/mobile")) {
      await serveMobileAsset(url.pathname, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "learnalong-ai",
        realtimeModel: OPENAI_REALTIME_MODEL,
        transcribeModel: OPENAI_TRANSCRIBE_MODEL,
        textModel: OPENAI_TEXT_MODEL,
        openAIBaseUrl: OPENAI_BASE_URL,
        hasOpenAIKey: Boolean(OPENAI_API_KEY)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const payload = await readJson(req);
      sendJson(res, 200, await callOpenAIResponses(payload, "chat"));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/youtube-summary") {
      const payload = await readJson(req);
      const summary = await summarizeYouTubeFromLink(payload);
      sendJson(res, summary.error ? 400 : 200, summary);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/learning-page") {
      const payload = await readJson(req);
      sendJson(res, 200, await callOpenAIResponses(payload, "learning-page"));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/digest") {
      const payload = await readJson(req);
      sendJson(res, 200, await callOpenAIResponses(payload, "digest"));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/transcribe") {
      const transcript = await transcribeAudio(req);
      sendJson(res, transcript.error ? 400 : 200, transcript);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/realtime-token") {
      const payload = await readJson(req);
      const token = await createRealtimeToken(payload);
      sendJson(res, token.error ? 400 : 200, token);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(PORT, () => {
  console.log(`LearnAlong AI server listening on http://localhost:${PORT}`);
});
