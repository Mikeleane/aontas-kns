import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Level = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";

type Option = { id: string; text: string };

type ListeningChunk = {
  id: string; // "c1"
  label: string; // "Chunk 1"
  text: string;
  anchors: string[];
  startSec?: number;
  endSec?: number;
};

type ListeningSide = {
  prompt: string;
  options?: Option[];
  left?: string[];
  right?: string[];
  items?: string[];
};

type ListeningActivityType =
  | "gist_mcq"
  | "detail_tf"
  | "detail_mcq"
  | "match"
  | "order"
  | "summary_mcq";

type ListeningActivity = {
  id: string; // "a1"
  type: ListeningActivityType;
  chunkId?: string;
  standard: ListeningSide;
  adapted: ListeningSide;
  /**
   * Single answer key shared by Standard/Adapted:
   * - MCQ: option id, e.g. "B"
   * - TF: "T" or "F"
   * - Order: correct ordered list of strings
   * - Match: array of numbers where answer[i] = matched right-index for left i (0-based)
   */
  answer: string | string[] | number[];
};

type ListeningPack = {
  meta: {
    title: string;
    level: Level;
    textType?: string;
    topic?: string;
    createdAtISO: string;
  };
  audio: {
    mode: "tts" | "url";
    voiceHint?: string;
    url?: string;
    rate?: number;
  };
  chunks: ListeningChunk[];
  activities: ListeningActivity[];
};

type ListeningPackRequestBody = {
  title?: string;
  level?: string;
  textType?: string;
  outputType?: string;
  questionFocus?: string;
  script?: string;
  selectedBlocks?: string[];
  blocks?: string[];
  audioMode?: "tts" | "url";
  audioUrl?: string;
};

function normalizeLevel(raw: string | undefined): Level {
  const v = (raw || "B1").toUpperCase().trim();
  if (v === "A1" || v === "A2" || v === "B1" || v === "B2" || v === "C1" || v === "C2") return v;
  return "B1";
}

function normalizeBlocks(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map(String)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

function looksLikePack(x: any): x is ListeningPack {
  return !!(x && x.meta && x.audio && Array.isArray(x.chunks) && Array.isArray(x.activities));
}

export async function POST(req: Request) {
  try {
    let body: ListeningPackRequestBody;
    try {
      body = (await req.json()) as ListeningPackRequestBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body in request." }, { status: 400 });
    }

    const title = (body.title || "Listening Focus").toString().trim() || "Listening Focus";
    const level = normalizeLevel(body.level);
    const textType = (body.textType || body.outputType || "").toString().trim() || undefined;
    const questionFocus = (body.questionFocus || "balanced").toString().trim();

    const script = (body.script || "").toString().trim();
    if (!script) {
      return NextResponse.json({ error: "Missing 'script' in request body." }, { status: 400 });
    }

    const audioMode = body.audioMode === "url" ? "url" : "tts";
    const audioUrl = audioMode === "url" ? (body.audioUrl || "").toString().trim() : "";

    const selectedBlocks = normalizeBlocks(body.selectedBlocks ?? body.blocks);

    const apiKey = process.env.OPENAI_API_KEY;
    const modelName = process.env.OPENAI_MODEL || "gpt-4.1-mini";

    if (!apiKey) {
      // Let the client fall back to its local generator.
      return NextResponse.json(
        { error: "Missing OPENAI_API_KEY on the server (use local fallback)." },
        { status: 501 }
      );
    }

    const systemPrompt = `
You are Aontas-10, generating an inclusive ESL Listening Focus pack.

You must output a JSON object representing a ListeningPack with this exact schema:

{
  "meta": {
    "title": string,
    "level": "A1"|"A2"|"B1"|"B2"|"C1"|"C2",
    "textType"?: string,
    "topic"?: string,
    "createdAtISO": string (ISO)
  },
  "audio": {
    "mode": "tts"|"url",
    "voiceHint"?: string,
    "url"?: string,
    "rate"?: number
  },
  "chunks": [
    {
      "id": "c1",
      "label": "Chunk 1",
      "text": string,
      "anchors": [string, ...],
      "startSec"?: number,
      "endSec"?: number
    }
  ],
  "activities": [
    {
      "id": "a1",
      "type": "gist_mcq"|"detail_tf"|"detail_mcq"|"match"|"order"|"summary_mcq",
      "chunkId"?: "c1",
      "standard": { "prompt": string, "options"?: [{"id":string,"text":string}], "left"?: string[], "right"?: string[], "items"?: string[] },
      "adapted":  { "prompt": string, "options"?: [{"id":string,"text":string}], "left"?: string[], "right"?: string[], "items"?: string[] },
      "answer": string | string[] | number[]
    }
  ]
}

INCLUSION RULES (critical)
- Standard and Adapted must target the SAME learning point and share ONE answer key.
- Adapted is NOT "easier content"; it is the same target with access supports:
  - clearer wording, smaller steps, fewer distractors, helpful hints.
- Do NOT change facts or add new content beyond what is in the script.

CHUNKING RULES
- Split the script into 3–6 chunks depending on length and CEFR level.
- Lower levels (A1/A2) should have shorter chunks.
- Each chunk must include 3–5 anchors: short, exact words/phrases from that chunk (memory hooks).

ACTIVITY RULES
- Map selected blocks (if provided) to activity types:
  - gist_main -> include 1 gist_mcq
  - detail -> include 3–6 detail activities across chunks (detail_mcq and/or detail_tf)
  - true_false -> include 2–3 detail_tf
  - vocabulary -> include 1 match activity (anchor/phrase -> chunk)
  - ordering -> include 1 order activity
  - cloze_gapfill -> include 1 summary_mcq (listening-friendly substitute)
- If no selected blocks are provided, include: gist_mcq, 4 detail_mcq, 1 match, 1 order (if 3+ chunks), and 1 summary_mcq (A2+).

MCQ CONSTRAINTS
- Standard MCQ: 4 options with ids A/B/C/D.
- Adapted MCQ: may use fewer options (2–4), BUT must keep the SAME option ids for the options shown.
- The correct answer is the option id ("A"/"B"/"C"/"D") and must be valid in BOTH.

TF CONSTRAINTS
- Answer must be "T" or "F".

ORDER CONSTRAINTS
- 'answer' is the correct ordered list.
- 'standard.items' and 'adapted.items' are the scrambled list shown to students.

MATCH CONSTRAINTS
- 'left' and 'right' are arrays.
- 'answer' is an array of numbers where answer[i] = index in 'right' that matches left[i].
- Standard and Adapted must have the SAME left/right and answer.

LANGUAGE
- Write prompts in clear, teacher-friendly English.
- Respect CEFR level ${level} in prompt complexity (especially Adapted prompts).

OUTPUT
- Respond ONLY with valid JSON. No markdown. No commentary.
`;

    const userPrompt = `
TITLE: ${title}
CEFR LEVEL: ${level}
TEXT TYPE: ${textType || "(not specified)"}
QUESTION FOCUS: ${questionFocus}
AUDIO MODE: ${audioMode}${audioMode === "url" ? ` (url: ${audioUrl || "(missing)"})` : ""}
SELECTED BLOCKS: ${selectedBlocks.length ? selectedBlocks.join(", ") : "(none)"}

LISTENING SCRIPT:
"""
${script}
"""
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        temperature: 0.35,
        max_tokens: 2600,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("OpenAI API error (listening-pack):", response.status, errText);
      return NextResponse.json(
        { error: "OpenAI API request failed (listening-pack)." },
        { status: 502 }
      );
    }

    const data: any = await response.json();
    const content: string = data?.choices?.[0]?.message?.content?.trim() ?? "";

    let parsed: any = null;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.error("Could not parse listening-pack JSON:", e, content.slice(0, 500));
      return NextResponse.json(
        { error: "Could not parse AI JSON output (listening-pack)." },
        { status: 502 }
      );
    }

    if (!looksLikePack(parsed)) {
      console.error("AI output did not match ListeningPack shape:", parsed);
      return NextResponse.json(
        { error: "AI output did not match expected ListeningPack shape." },
        { status: 502 }
      );
    }

    // Fill a couple of safe defaults if the model forgets.
    if (!parsed.meta.createdAtISO) parsed.meta.createdAtISO = new Date().toISOString();
    if (!parsed.audio) parsed.audio = { mode: audioMode };
    if (!parsed.audio.mode) parsed.audio.mode = audioMode;
    if (audioMode === "url" && audioUrl && !parsed.audio.url) parsed.audio.url = audioUrl;

    return NextResponse.json(parsed);
  } catch (err: any) {
    console.error("/api/listening-pack error:", err);
    return NextResponse.json({ error: "Unexpected error in listening-pack." }, { status: 500 });
  }
}
