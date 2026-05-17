# LearnAlong AI Product Brief

## One-Liner

LearnAlong AI is a voice-first browser learning companion. It helps people ask questions while watching or reading, keeps useful notes, and turns the session into a shareable learning article.

中文表达：帮你看懂，再沉淀。

## Target User

People who regularly learn from YouTube talks, X threads, technical blogs, AI product launches, and developer docs, but often get stuck on unfamiliar concepts while the content keeps moving.

## Core Pain

- Copying links into a chat app interrupts the learning flow.
- Summary tools explain the source, but not the learner's personal confusion.
- Video context is temporal: “what did they just say?” matters as much as the full summary.
- Good questions disappear after the session instead of becoming reusable notes.

## Desired Experience

While watching a video or reading a page, the user can hold a button and ask:

```text
What is he talking about?
刚才这段是什么意思？
这个和 agent 有什么关系？
记一下这个点。
```

LearnAlong AI should:

1. Pause the video while the user asks.
2. Sync the latest page/video context.
3. Answer with Realtime voice.
4. Save notes when the user asks it to remember something.
5. Generate a shareable HTML article from the captured context and the user's questions.

## MVP Scope

- Chrome / Edge side panel extension.
- Local Node server that keeps the OpenAI API key out of the extension.
- Push-to-talk Realtime voice interaction.
- Space-key voice shortcut.
- Local context tracking for page text, YouTube video state, captions, transcript, and recent timeline.
- Local memory for voice notes and question history.
- Shareable HTML article generation with images and notes distilled from user questions.
- Chinese, English, and bilingual article output.

## Not In Scope Yet

- Chrome Web Store release.
- Cloud account system.
- Notion / Slack sync.
- Full long-video ingestion pipeline.
- Automatic daily digest.

## Validation Question

The early product should answer one question:

```text
Did this make me ask more, understand faster, and keep better notes while learning?
```
