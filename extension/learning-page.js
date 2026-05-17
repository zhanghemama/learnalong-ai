const STORAGE_PREFIX = "learnAlongAi.learningPage.";

openStoredLearningPage();

async function openStoredLearningPage() {
  const status = document.querySelector("#status");
  const id = new URL(location.href).searchParams.get("id");
  if (!id) {
    status.textContent = "没有找到学习页编号。请回到 LearnAlong AI 重新生成。";
    return;
  }

  const key = `${STORAGE_PREFIX}${id}`;
  try {
    const stored = await chrome.storage.local.get(key);
    const html = stored[key]?.html;
    if (!html) {
      status.textContent = "学习页内容已经过期。请回到 LearnAlong AI 重新生成。";
      return;
    }
    document.open();
    document.write(html);
    document.close();
  } catch (error) {
    status.textContent = `学习页打开失败：${error?.message || String(error)}`;
  }
}
