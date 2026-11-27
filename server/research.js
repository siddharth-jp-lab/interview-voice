const MODEL = "gpt-4o-mini";

export async function researchTopic(topic, { groupTitle } = {}) {
  const subject = String(topic || "").trim().slice(0, 120);
  if (subject.length < 2) return null;
  const text = await researchText(subject);
  if (!text) return null;
  const shape = groupTitle
    ? `Return JSON with key leaves, an array of 4 to 6 items. These leaves belong under the existing group "${groupTitle}".`
    : "Return JSON with key title (the group name) and key leaves, an array of 4 to 6 items.";
  const tree = await ask(
    `${shape} Each item has title, hint, detail, sources, and references. Each title is a short skill name of two to four words and is not a question. Each hint is one concrete interview question about what breaks, in one sentence. detail is the study brief for that subtopic: what has to be known, how it fails, and what a solid answer includes, in 180 to 320 words. sources and references are arrays of {title, url}. sources are the pages the detail is drawn from. references are further reading. Use https URLs only. Use only the brief. Do not add skills the brief does not support.`,
    text,
  );
  const normalized = normalizeTree(tree, { appending: Boolean(groupTitle) });
  if (!normalized) return null;
  normalized.leaves = (await Promise.all(normalized.leaves.map(checkLeaf))).filter(Boolean);
  const min = groupTitle ? 3 : 4;
  if (normalized.leaves.length < min) return null;
  if (!groupTitle) {
    const groupBrief = await researchBrief(normalized.title);
    if (groupBrief) {
      normalized.detail = groupBrief.detail;
      normalized.reading = groupBrief.reading;
    }
  }
  return normalized;
}

export async function researchBrief(title, { parentTitle } = {}) {
  const subject = parentTitle ? `${parentTitle}: ${title}` : title;
  const text = await researchText(subject);
  if (!text) return null;
  const cited = await ask(
    "Return JSON with keys detail, sources, and references. detail is one study brief for this exact topic: what has to be known, how it fails in practice, and what a solid answer includes. Write 180 to 320 words. sources and references are arrays of {title, url}. sources are the pages the detail is drawn from. references are further reading. Use https URLs for real public documentation, books, or papers. Use only the brief.",
    text,
  );
  const detail = String(cited?.detail || "").trim().slice(0, 4500);
  if (detail.length < 200) return null;
  let reading = await checkedReading(cited);
  if (reading.sources.length === 0) {
    const again = await ask(
      "Return JSON with keys sources and references, arrays of {title, url}. The previous links did not resolve. Cite different https pages that exist: official documentation or a well-known book or paper. sources are required. Use only the brief.",
      text,
    );
    reading = await checkedReading(again);
  }
  if (reading.sources.length === 0) return null;
  return { detail, reading };
}

async function researchText(subject) {
  const brief = await ask(
    "You research one topic for a mid-level interview. Return JSON with one key, brief, whose value is a single string. Cover everything that has to be known, how it fails in practice, and what a solid answer includes. Stay under 900 words. Do not include a skill list.",
    `Topic: ${subject}`,
  );
  const text = briefText(brief?.brief).slice(0, 6000);
  return text.length < 80 ? "" : text;
}

function briefText(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
}

function normalizeTree(tree, { appending }) {
  const leaves = Array.isArray(tree?.leaves) ? tree.leaves.map(cleanLeaf).filter(Boolean).slice(0, 6) : [];
  const min = appending ? 3 : 4;
  if (leaves.length < min) return null;
  if (appending) return { leaves };
  const title = cleanTitle(tree?.title);
  if (!title) return null;
  return { title, leaves };
}

function cleanLeaf(leaf) {
  const title = cleanTitle(leaf?.title);
  const hint = String(leaf?.hint || "").trim().replace(/\s+/g, " ").slice(0, 400);
  const detail = String(leaf?.detail || "").trim().slice(0, 4500);
  if (!title || title.includes("?") || hint.length < 20 || !hint.includes("?") || detail.length < 200) return null;
  return { title, hint, detail, sources: linkList(leaf?.sources), references: linkList(leaf?.references) };
}

function linkList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      title: String(item?.title || "").trim().slice(0, 120),
      url: String(item?.url || "").trim(),
    }))
    .filter((item) => item.title.length >= 2 && item.url.startsWith("https://"))
    .slice(0, 4);
}

async function checkLeaf(leaf) {
  const reading = await checkedReading(leaf);
  if (reading.sources.length === 0) return null;
  return { title: leaf.title, hint: leaf.hint, detail: leaf.detail, reading };
}

async function checkedReading(value) {
  const sources = await liveLinks(linkList(value?.sources));
  const references = await liveLinks(linkList(value?.references));
  return { sources, references };
}

async function liveLinks(items) {
  const checks = await Promise.all(items.map(async (item) => ((await linkAnswers(item.url)) ? item : null)));
  return checks.filter(Boolean);
}

async function linkAnswers(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    return response.status < 400 || [401, 403, 405, 429].includes(response.status);
  } catch {
    return false;
  }
}

function cleanTitle(value) {
  const title = String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
  return title.length >= 2 ? title : "";
}

async function ask(system, user) {
  if (!process.env.OPENAI_API_KEY) {
    throw Object.assign(new Error("Set OPENAI_API_KEY in .env"), { status: 503 });
  }
  let response;
  let data;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(45000),
      });
      data = await response.json();
      break;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  if (!response.ok) {
    throw Object.assign(new Error("Research failed"), { status: 502 });
  }
  try {
    return JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch {
    return null;
  }
}
