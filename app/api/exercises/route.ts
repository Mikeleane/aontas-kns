import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ExerciseType = "gist" | "detail" | "trueFalse" | "vocab" | "cloze" | "ordering";

type ExerciseSide = {
  prompt: string;
  options?: string[];
};

type ExerciseItem = {
  id: number;
  type: ExerciseType;
  skill: string;
  answer: string | string[];
  standard: ExerciseSide;
  adapted: ExerciseSide;
};

type ExercisesResponseBody = { items: ExerciseItem[] };

function pickString(body: any, keys: string[]): string {
  for (const k of keys) {
    const v = body?.[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function pickBool(body: any, key: string): boolean | undefined {
  const v = body?.[key];
  if (typeof v === "boolean") return v;
  return undefined;
}

function pickStringArray(body: any, keys: string[]): string[] {
  for (const k of keys) {
    const v = body?.[k];
    if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function normalizeBlocksToFlags(blockIds: string[]) {
  // Support both "new UI" ids and older names.
  const normalized = new Set(
    blockIds
      .map((b) => b.toLowerCase().trim())
      .map((b) => b.replace(/\s+/g, "_"))
  );

  const has = (...ids: string[]) => ids.some((id) => normalized.has(id));

  return {
    includeGist: has("gist", "gist_main", "main_idea", "mainidea"),
    includeDetail: has("detail", "detail_questions", "details"),
    includeTrueFalse: has("truefalse", "true_false", "tf", "true_false_questions"),
    includeVocab: has("vocab", "vocabulary", "lexis"),
    includeCloze: has("cloze", "cloze_gapfill", "gap_fill", "gapfill", "cloze_gap_fill"),
    includeOrdering: has("ordering", "sequence", "sequencing", "order"),
  };
}

export async function POST(req: Request) {
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body in request." }, { status: 400 });
    }

    // Text fields: accept legacy + new names
    const standardText = pickString(body, ["standardText", "standardOutput", "standard"]);
    const adaptedText = pickString(body, ["adaptedText", "adaptedOutput", "adapted"]);

    // Meta
    const outputLanguage = pickString(body, ["outputLanguage", "language"]) || "English (British)";
    const level = pickString(body, ["level", "cefrLevel", "cefr"]) || "B1";
    const outputType = pickString(body, ["outputType", "genre"]) || "article";

    // Blocks: accept either booleans or arrays
    const blocks = pickStringArray(body, ["blocks", "selectedBlocks", "exerciseBlocks"]);
    const fromBlocks = normalizeBlocksToFlags(blocks);

    const includeGist = pickBool(body, "includeGist") ?? fromBlocks.includeGist;
    const includeDetail = pickBool(body, "includeDetail") ?? fromBlocks.includeDetail;
    const includeTrueFalse = pickBool(body, "includeTrueFalse") ?? fromBlocks.includeTrueFalse;
    const includeVocab = pickBool(body, "includeVocab") ?? fromBlocks.includeVocab;
    const includeCloze = pickBool(body, "includeCloze") ?? fromBlocks.includeCloze;
    const includeOrdering = pickBool(body, "includeOrdering") ?? fromBlocks.includeOrdering;

    const questionFocus = pickString(body, ["questionFocus", "focus"]) || "balanced";

    if (!standardText || !adaptedText) {
      return NextResponse.json(
        { error: "Both standardText and adaptedText are required." },
        { status: 400 }
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const modelName = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    if (!apiKey) {
      return NextResponse.json({ error: "Missing OPENAI_API_KEY on the server." }, { status: 500 });
    }

    const enabledBlocks: string[] = [];
    if (includeGist) enabledBlocks.push("gist / main idea");
    if (includeDetail) enabledBlocks.push("detail questions");
    if (includeTrueFalse) enabledBlocks.push("true / false");
    if (includeVocab) enabledBlocks.push("vocabulary / connectors / reference words");
    if (includeCloze) enabledBlocks.push("cloze / gap-fill");
    if (includeOrdering) enabledBlocks.push("ordering / sequencing");

    if (enabledBlocks.length === 0) {
      return NextResponse.json({ error: "Select at least one exercise block." }, { status: 400 });
    }

    const systemPrompt = `
You are helping a teacher create inclusive reading comprehension exercises.

You are given:
- A STANDARD version of a text.
- An ADAPTED version of the same text.
- CEFR level and output type/genre.
- A list of enabled exercise blocks.
- A question-focus preference (optional).

Your job:
- Create a SINGLE list of exercise items.
- Each item has:
  - an id (1, 2, 3, ...),
  - a "type" (block type),
  - a "skill" description,
  - an "answer" (string or array of strings),
  - a STANDARD prompt (possibly with options),
  - an ADAPTED prompt (possibly with options).

CRITICAL INCLUSION RULES
- STANDARD and ADAPTED prompts MUST target the SAME learning point and share the SAME answer key.
- Adapted must NOT be "baby easy" or a different lesson. It is the SAME learning target, with access supports:
  - clearer wording, less clutter, smaller steps,
  - more structure (e.g., table headings, word bank),
  - fewer or cleaner distractors,
  - optional choices instead of open writing,
  - but NO changing the answer and NO removing the core idea.
- Imagine a mixed classroom: teacher says "Everyone answer Question 3!" and both groups can do it.

Question focus preference: ${questionFocus}

Allowed values for "type":
- "gist"
- "detail"
- "trueFalse"
- "vocab"
- "cloze"
- "ordering"

Use the "skill" field to describe the subtype (short), such as:
- "main idea"
- "matching headings to paragraphs"
- "detail questions"
- "information gap / table completion"
- "true/false comprehension"
- "word meaning"
- "reference word"
- "connector meaning"
- "cloze with word bank"
- "event ordering"

BLOCK REQUIREMENTS
1) GIST / MAIN IDEA (when enabled)
- At least ONE item: type "gist" skill "main idea"
- AND, IF the text has at least 3 clear paragraphs/sections: ONE item: type "gist" skill "matching headings to paragraphs"
  - STANDARD: may include one extra heading.
  - ADAPTED: simpler wording and/or fewer headings, but still matching the SAME paragraphs used in the answer key.

2) DETAIL QUESTIONS (when enabled)
- At least ONE item: type "detail" skill "detail questions"
- AND, IF the text contains at least 3 distinct factual pieces: ONE item: type "detail" skill "information gap / table completion"
  - STANDARD: more open.
  - ADAPTED: more support (options/word bank/partial answers) while keeping the SAME filled answers.

3) TRUE / FALSE (when enabled)
- Create 2–3 items: type "trueFalse" skill "true/false comprehension"
  - STANDARD may add "If false, correct it."
  - ADAPTED should usually be just T/F (or very guided correction).

4) VOCABULARY / CONNECTORS / REFERENCE WORDS (when enabled)
VERY IMPORTANT RULE:
- Only create vocab items for words/phrases that appear IDENTICALLY in BOTH texts (case-insensitive match of the same spelling).
- If it only appears in one version (or appears differently), do NOT use it.

When vocab is enabled, you MUST:
- At least ONE item: type "vocab" skill "word meaning"
- AND at least ONE item: type "vocab" skill "reference word" OR "connector meaning"

5) CLOZE / GAP-FILL (when enabled)
- ONE item: type "cloze" skill "cloze with word bank" (3–6 sentences)
- "answer" is an array of missing words in correct order.
- STANDARD: no word bank OR small word bank.
- ADAPTED: MUST include a clear word bank.
- Use the SAME missing words for both.

6) ORDERING / SEQUENCING (when enabled)
- ONE item: type "ordering" skill "event ordering" (or similar)
- "answer" is an array showing the correct order.

Quantity overall:
- Aim for ~8–12 items total across all enabled blocks (lower if text is short).

Language / difficulty:
- Respect CEFR level ${level}.
- Keep prompts in ${outputLanguage}.

Output format:
Return ONLY valid JSON with this exact shape:
{
  "items": [
    {
      "id": 1,
      "type": "gist" | "detail" | "trueFalse" | "vocab" | "cloze" | "ordering",
      "skill": "short skill label",
      "answer": "..." OR ["...", "..."],
      "standard": { "prompt": "string", "options": ["..."] },
      "adapted": { "prompt": "string", "options": ["..."] }
    }
  ]
}
- ids MUST be consecutive integers starting at 1.
- Do not include any commentary outside JSON.
`;

    const userPrompt = `
STANDARD TEXT:
"""
${standardText}
"""

ADAPTED TEXT:
"""
${adaptedText}
"""

Context:
- Output language: ${outputLanguage}
- CEFR level: ${level}
- Output text type: ${outputType}
- Enabled blocks: ${enabledBlocks.join(", ")}

Return only JSON in the required format.
`;

    const completionRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!completionRes.ok) {
      const errJson = await completionRes.json().catch(() => null);
      console.error("OpenAI API error:", completionRes.status, errJson);
      return NextResponse.json(
        { error: errJson?.error?.message || `OpenAI API error: ${completionRes.status}` },
        { status: 500 }
      );
    }

    const completionJson = (await completionRes.json()) as any;
    const raw = completionJson.choices?.[0]?.message?.content;
    if (!raw) {
      return NextResponse.json({ error: "No response from model when generating exercises." }, { status: 500 });
    }

    let parsed: ExercisesResponseBody;
    try {
      parsed = JSON.parse(raw) as ExercisesResponseBody;
    } catch (err) {
      console.error("Failed to parse exercises JSON:", err, raw);
      return NextResponse.json(
        { error: "Failed to parse exercises JSON from model. Try again or simplify the input." },
        { status: 500 }
      );
    }

    if (!parsed.items || !Array.isArray(parsed.items)) {
      return NextResponse.json({ error: "Model response did not contain a valid items array." }, { status: 500 });
    }

    // Ensure ids are consecutive: 1..N
    const sorted = [...parsed.items].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    sorted.forEach((item, idx) => {
      item.id = idx + 1;
    });

    return NextResponse.json({ items: sorted }, { status: 200 });
  } catch (err: any) {
    console.error("Error in /api/exercises:", err);
    return NextResponse.json(
      { error: err?.message || "An unexpected error occurred while generating exercises." },
      { status: 500 }
    );
  }
}
