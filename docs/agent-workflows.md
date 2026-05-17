# Agent Workflow

LearnAlong AI is designed as a small agent workspace around a single learning session.

## Current Runtime Flow

```text
Browser page / YouTube video
  -> Content reader
  -> Local timeline and memory
  -> Realtime tutor
  -> Note writer
  -> Article generator
```

## Content Reader

Collects learning context from the current browser tab.

Inputs:

- Page title and URL
- Visible page text
- Selected text
- YouTube video state
- Transcript or visible captions when available
- Recent local timeline samples

Output:

- Structured context passed to Realtime voice and article generation

## Realtime Tutor

Answers the learner's question while staying close to the current context.

Responsibilities:

- Pause playback when the learner starts asking.
- Accept push-to-talk voice.
- Buffer audio while the Realtime connection is being established.
- Respond in the selected language.
- Resume playback only after the AI voice answer finishes.

## Memory Agent

Keeps useful learning artifacts locally.

Current memory types:

- `voice-note`: saved when the user says things like “记一下”
- `session`: question and answer history for the current source
- `blind-spot`: concepts the user explicitly wants to remember later

Storage:

```text
chrome.storage.local
  learnAlongAi.v1
```

## Article Generator

Turns a session into a readable HTML article.

Inputs:

- Transcript timeline
- Page text
- Recent video context
- User questions
- Saved notes
- Video thumbnail or current frame

Output:

- A shareable HTML article with:
  - headline
  - lead
  - main sections
  - notable moments
  - concepts worth knowing
  - takeaways
  - notes distilled from the learner's own questions
