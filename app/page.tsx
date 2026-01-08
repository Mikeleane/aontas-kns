"use client";

import React, { FormEvent, useMemo, useState } from "react";
import jsPDF from "jspdf";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
} from "docx";

/**
 * Aontas 10 — unified generator page
 * - Reading Pack: Standard/Adapted reading + exercises + simple interactive HTML export
 * - Listening Focus Pack: separate interactive HTML export + PDF printables (Std/Adpt + Teacher Key)
 *
 * IMPORTANT inclusion rule: Standard + Adapted share ONE answer key.
 */

/* ----------------------------- Types (Reading) ----------------------------- */

type Level = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
type ExportFormat = "txt" | "docx" | "pdf";

type AdaptResponse = {
  standardOutput: string;
  adaptedOutput: string;
  error?: string;
  warning?: string;
};

type ExerciseSide = {
  prompt: string;
  options?: string[];
};

type ExerciseItem = {
  id: number;
  type: string;
  skill: string;
  answer: string | string[];
  standard: ExerciseSide;
  adapted: ExerciseSide;
};

type ExercisesResponse = {
  items?: ExerciseItem[];
  error?: string;
};

/* --------------------------- Types (Listening) ---------------------------- */

type Option = { id: string; text: string };

type ListeningChunk = {
  id: string; // "c1"
  label: string; // "Chunk 1"
  text: string;
  anchors: string[]; // 3–5 words pinned as memory anchors
  startSec?: number; // optional timestamps for real audio
  endSec?: number;
};

type ListeningSide = {
  prompt: string;
  // MCQ / Summary MCQ:
  options?: Option[];
  // Match:
  left?: string[];
  right?: string[];
  // Order:
  items?: string[]; // what student sees (scrambled)
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
  chunkId?: string; // ties detail tasks to a chunk
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

/* ------------------------------ Constants -------------------------------- */

const levels: Level[] = ["A1", "A2", "B1", "B2", "C1", "C2"];

const OUTPUT_LANGUAGES = [
  "English",
  "Spanish",
  "French",
  "German",
  "Italian",
  "Portuguese",
  "Catalan",
  "Irish",
] as const;

const TEXT_TYPES = [
  "Article",
  "News report",
  "Academic text",
  "Formal email",
  "Dialogue",
  "Narrative story",
  "Opinion piece",
] as const;

const LEVEL_RANK: Record<Level, number> = {
  A1: 1,
  A2: 2,
  B1: 3,
  B2: 4,
  C1: 5,
  C2: 6,
};

function levelAtMost(level: Level, max: Level) {
  return LEVEL_RANK[level] <= LEVEL_RANK[max];
}
function levelAtLeast(level: Level, min: Level) {
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}

type ExerciseBlockId =
  | "gist_main"
  | "detail"
  | "vocabulary"
  | "true_false"
  | "cloze_gapfill"
  | "ordering";

type QuestionFocus =
  | "balanced"
  | "whowhatwhere"
  | "vocab_phrases"
  | "text_structure"
  | "exam_style";

const EXERCISE_BLOCKS: Array<{
  id: ExerciseBlockId;
  label: string;
  short: string;
}> = [
  { id: "gist_main", label: "Gist / main idea", short: "Gist / main idea" },
  { id: "detail", label: "Detail questions", short: "Detail questions" },
  { id: "vocabulary", label: "Vocabulary", short: "Vocabulary" },
  { id: "true_false", label: "True / False", short: "True / False" },
  { id: "cloze_gapfill", label: "Cloze / gap-fill", short: "Cloze / gap-fill" },
  { id: "ordering", label: "Ordering", short: "Ordering" },
];

const QUESTION_FOCUS_OPTIONS: Array<{ id: QuestionFocus; label: string; hint: string }> = [
  {
    id: "balanced",
    label: "Balanced comprehension",
    hint: "Mix of gist, detail and some vocabulary — a good all-round reading lesson.",
  },
  {
    id: "whowhatwhere",
    label: "Who / what / where?",
    hint: "Concrete understanding: people, places, times, and simple facts.",
  },
  {
    id: "vocab_phrases",
    label: "Vocabulary & phrases",
    hint: "Build useful words and chunks from the text in context.",
  },
  {
    id: "text_structure",
    label: "Text structure & sequencing",
    hint: "Order events, identify sections, connectives, and logical flow.",
  },
  {
    id: "exam_style",
    label: "Exam-style reading",
    hint: "Tighter distractors, inference, and summary selection (level-appropriate).",
  },
];

function defaultBlocksFor(level: Level, focus: QuestionFocus): ExerciseBlockId[] {
  if (focus === "whowhatwhere") {
    return levelAtMost(level, "A2")
      ? ["gist_main", "detail", "true_false", "vocabulary"]
      : ["gist_main", "detail", "true_false"];
  }
  if (focus === "vocab_phrases") {
    return ["vocabulary", "cloze_gapfill", "detail"];
  }
  if (focus === "text_structure") {
    return ["gist_main", "ordering", "detail"];
  }
  if (focus === "exam_style") {
    return levelAtLeast(level, "B2")
      ? ["gist_main", "detail", "true_false", "ordering", "vocabulary"]
      : ["gist_main", "detail", "true_false"];
  }
  // balanced
  return levelAtMost(level, "A2")
    ? ["gist_main", "detail", "true_false", "vocabulary"]
    : ["gist_main", "detail", "vocabulary"];
}

const STOPWORDS = new Set(
  [
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "so",
    "to",
    "of",
    "in",
    "on",
    "for",
    "with",
    "at",
    "by",
    "from",
    "as",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "it",
    "this",
    "that",
    "these",
    "those",
    "i",
    "you",
    "he",
    "she",
    "we",
    "they",
    "them",
    "his",
    "her",
    "their",
    "our",
    "my",
    "your",
    "not",
    "no",
    "yes",
    "do",
    "does",
    "did",
    "done",
    "can",
    "could",
    "would",
    "should",
    "will",
    "just",
    "about",
    "into",
    "over",
    "under",
    "than",
    "then",
    "there",
    "here",
    "when",
    "where",
    "what",
    "who",
    "whom",
    "which",
    "why",
    "how",
    "also",
    "because",
    "while",
    "if",
    "up",
    "down",
    "out",
    "off",
    "more",
    "most",
    "some",
    "any",
    "each",
    "many",
    "such",
  ].map((s) => s.toLowerCase())
);

/* ------------------------------ Utilities -------------------------------- */

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 70);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function safeSerializeForHtml(obj: unknown) {
  // Prevent accidental </script> breaks
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

function splitSentencesRough(text: string): string[] {
  const cleaned = text
    .replace(/\s+/g, " ")
    .replace(/([.?!])\s+/g, "$1|")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

  // Fallback if punctuation is scarce
  if (cleaned.length <= 1) {
    return text
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return cleaned;
}

function chunkForWorkingMemory(text: string, targetChars = 260): string[] {
  const sentences = splitSentencesRough(text);
  const chunks: string[] = [];
  let buf = "";

  for (const s of sentences) {
    if (!buf) {
      buf = s;
      continue;
    }
    if ((buf + " " + s).length <= targetChars) {
      buf = buf + " " + s;
    } else {
      chunks.push(buf);
      buf = s;
    }
  }
  if (buf) chunks.push(buf);

  // If it still ended up huge, split by length
  const final: string[] = [];
  for (const c of chunks) {
    if (c.length <= targetChars * 1.8) {
      final.push(c);
    } else {
      for (let i = 0; i < c.length; i += targetChars) {
        final.push(c.slice(i, i + targetChars).trim());
      }
    }
  }
  return final.filter(Boolean);
}

function extractAnchors(text: string, max = 4): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));

  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

function option(id: string, text: string): Option {
  return { id, text };
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ----------------------- Listening Pack (Local Gen) ----------------------- */
/**
 * Local generator = fallback + dev tool.
 * Your ideal version is an LLM-backed /api/listening-pack route.
 */

function buildLocalListeningPack(args: {
  title: string;
  level: Level;
  textType?: string;
  script: string;
  audioMode: "tts" | "url";
  audioUrl?: string;
  questionFocus?: QuestionFocus;
  selectedBlocks?: ExerciseBlockId[];
}): ListeningPack {
  const { title, level, textType, script, audioMode, audioUrl, questionFocus } = args;

  // CEFR-tuned chunk size: lower levels = smaller chunks (reduced working-memory load)
  const targetChars =
    levelAtMost(level, "A1") ? 180 :
    levelAtMost(level, "A2") ? 205 :
    levelAtMost(level, "B1") ? 240 :
    levelAtMost(level, "B2") ? 280 :
    levelAtMost(level, "C1") ? 320 : 340;

  const focus: QuestionFocus = questionFocus || "balanced";

  const rawChunks = chunkForWorkingMemory(script, targetChars);

  const chunks: ListeningChunk[] = (rawChunks.length ? rawChunks : [script]).map((t, idx) => {
    const id = `c${idx + 1}`;
    const anchors = extractAnchors(t, 5);
    return {
      id,
      label: `Chunk ${idx + 1}`,
      text: t.trim(),
      anchors,
    };
  });

  const unique = (arr: string[]) =>
    Array.from(new Set(arr.map((s) => (s || "").trim()).filter(Boolean)));

  const ALL_LETTERS: Array<"A" | "B" | "C" | "D"> = ["A", "B", "C", "D"];

  function option(id: "A" | "B" | "C" | "D", label: string): Option {
    return { id, text: label };
  }

  function cleanSnippet(s: string, maxLen = 70) {
    const oneLine = (s || "").replace(/\s+/g, " ").trim();
    if (oneLine.length <= maxLen) return oneLine;
    // cut at word boundary
    const cut = oneLine.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim() + "…";
  }

  function extractPhrasalVerbsLocal(text: string): string[] {
    // lightweight heuristic: verb + particle (no claims of perfect linguistics)
    const t = (text || "").toLowerCase();
    const particles = ["up", "down", "in", "out", "on", "off", "over", "away", "back", "through", "around", "into"];
    const verbs = ["get", "go", "take", "put", "come", "look", "turn", "pick", "set", "find", "give", "make", "keep", "carry", "bring", "run", "work", "break", "hold"];
    const re = new RegExp(`\\b(${verbs.join("|")})\\s+(${particles.join("|")})\\b`, "g");
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) out.push(`${m[1]} ${m[2]}`);
    return unique(out).slice(0, 12);
  }

  function extractCollocationsLocal(text: string): string[] {
    // simple bigram frequency (ignores punctuation); good enough for a fallback.
    const toks = (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9'\s-]/g, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter(Boolean);

    const stop = new Set([
      "the","a","an","and","or","but","so","because","as","if","then","than","that","this","these","those",
      "to","of","in","on","at","for","from","with","by","about","into","over","after","before","between",
      "is","are","was","were","be","been","being","have","has","had","do","does","did","will","would","can","could","should","may","might","must",
      "i","you","he","she","it","we","they","me","him","her","us","them","my","your","his","its","our","their"
    ]);

    const counts = new Map<string, number>();
    for (let i = 0; i < toks.length - 1; i++) {
      const w1 = toks[i], w2 = toks[i + 1];
      if (stop.has(w1) || stop.has(w2)) continue;
      if (w1.length < 3 || w2.length < 3) continue;
      const bg = `${w1} ${w2}`;
      counts.set(bg, (counts.get(bg) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([bg]) => bg)
      .slice(0, 12);
  }

  const pv = extractPhrasalVerbsLocal(script);
  const col = extractCollocationsLocal(script);
  const phrasePool = unique([...pv, ...col]);

  const anchorPool = unique(chunks.flatMap((c) => c.anchors)).slice(0, 16);

  function pickChunkKey(c: ListeningChunk): string {
    // Prefer a phrase-level item for B1+, otherwise fall back to an anchor.
    if (levelAtLeast(level, "B1")) {
      const found = phrasePool.find((p) => c.text.toLowerCase().includes(p));
      if (found) return found;
    }
    return c.anchors[0] || cleanSnippet(c.text, 28) || "a key detail";
  }

  function makeMcq(
    id: string,
    chunkId: string | undefined,
    promptStd: string,
    promptAdp: string,
    correctText: string,
    distractorTexts: string[],
    correctLetter: "A" | "B" | "C" | "D",
    adaptedOptionCount: number
  ): ListeningActivity {
    const pool = unique(distractorTexts).filter((d) => d && d !== correctText);
    const fill: Record<"A"|"B"|"C"|"D", string> = { A: "", B: "", C: "", D: "" };
    fill[correctLetter] = correctText;

    const otherLetters = ALL_LETTERS.filter((x) => x !== correctLetter);
    for (let i = 0; i < otherLetters.length; i++) {
      fill[otherLetters[i]] = pool[i] || `Option ${i + 1}`;
    }

    const options: Option[] = ALL_LETTERS.map((L) => option(L, fill[L]));

    // Adapted = same IDs, fewer distractors + simpler labels
    const adaptedKeep = [correctLetter, ...otherLetters.slice(0, Math.max(1, adaptedOptionCount - 1))];
    const adaptedOptions: Option[] = options.filter((o) => adaptedKeep.includes(o.id));

    return {
      id,
      type: "detail_mcq",
      chunkId,
      answer: correctLetter,
      standard: { prompt: promptStd, options },
      adapted: { prompt: promptAdp, options: adaptedOptions },
    };
  }

  function makeOrder(id: string, items: string[], adaptedHint: string): ListeningActivity {
    const scrambled = shuffle(items);
    return {
      id,
      type: "order",
      answer: items,
      standard: {
        prompt: "Put these parts in the order you hear them.",
        items: scrambled,
      },
      adapted: {
        prompt: "Put these parts in the order you hear them. " + adaptedHint,
        items: scrambled,
      },
    };
  }

  function makeMatchAnchorsToChunks(id: string, picks: { anchor: string; chunkLabel: string }[]): ListeningActivity {
    const left = picks.map((p) => p.anchor);
    const right = shuffle(picks.map((p) => p.chunkLabel));
    const answer = picks.map((p) => right.indexOf(p.chunkLabel));

    return {
      id,
      type: "match",
      answer,
      standard: {
        prompt: "Match each word/phrase to the chunk where you hear it.",
        left,
        right,
      },
      adapted: {
        prompt: "Match each word/phrase to the chunk where you hear it. Tip: do the easiest one first.",
        left,
        right,
      },
    };
  }

  // --- Activity recipe (CEFR + focus + selected blocks) ---
  const activities: ListeningActivity[] = [];

  const blockSet = new Set<ExerciseBlockId>((args.selectedBlocks || []).filter(Boolean));
  const hasBlockPrefs = blockSet.size > 0;

  const allowGist = !hasBlockPrefs || blockSet.has("gist_main");
  const allowDetail = !hasBlockPrefs || blockSet.has("detail");
  const allowTrueFalse = hasBlockPrefs
    ? blockSet.has("true_false")
    : focus === "balanced" || focus === "exam_style";

  const allowOrder = hasBlockPrefs
    ? blockSet.has("ordering")
    : focus === "text_structure" || focus === "balanced" || focus === "exam_style";

  const allowMatch = hasBlockPrefs
    ? blockSet.has("vocabulary")
    : focus === "vocab_phrases" || focus === "balanced" || focus === "exam_style";

  // Map "cloze / gap-fill" to a listening-friendly summary check.
  const allowSummary = hasBlockPrefs ? blockSet.has("cloze_gapfill") : levelAtLeast(level, "A2");

  function makeTf(id: string, chunkId: string | undefined, statement: string, answer: "T" | "F"): ListeningActivity {
    return {
      id,
      type: "detail_tf",
      chunkId,
      answer,
      standard: { prompt: statement },
      adapted: {
        prompt: levelAtMost(level, "A2")
          ? statement + " (Choose T or F.)"
          : statement + " (Choose True or False.)",
      },
    };
  }

  // 1) Gist question
  if (allowGist) {
    const theme = anchorPool.slice(0, 4).join(", ") || "the main idea";
    const gistCorrect = `Mainly about: ${theme}`;
    const gistDistractors = [
      "Mainly about: a sports match and the score",
      "Mainly about: travel plans and booking details",
      "Mainly about: cooking a recipe and ingredients",
    ];
    const gistCorrectLetter: "A" | "B" | "C" | "D" = levelAtMost(level, "A1") ? "A" : "B";
    const gistAdaptCount = levelAtMost(level, "A1") ? 2 : levelAtMost(level, "A2") ? 3 : 4;

    const gistAct = makeMcq(
      "gist",
      undefined,
      "Listen once. What is the main idea?",
      "Listen once. What is the main idea? (You can listen again.)",
      gistCorrect,
      gistDistractors,
      gistCorrectLetter,
      gistAdaptCount
    );
    gistAct.type = "gist_mcq";
    activities.push(gistAct);
  }

  // 2) Detail questions (chunk-based)
  if (allowDetail) {
    const maxDetail =
      levelAtMost(level, "A1") ? 3 :
      levelAtMost(level, "A2") ? 4 :
      levelAtMost(level, "B1") ? 5 :
      levelAtMost(level, "B2") ? 6 : 7;

    const detailCount = Math.min(maxDetail, chunks.length);

    for (let i = 0; i < detailCount; i++) {
      const c = chunks[i];
      const key = pickChunkKey(c);

      const correctLetter = ALL_LETTERS[i % 4];
      const distractors = unique([
        ...chunks.filter((_, j) => j !== i).map((cc) => pickChunkKey(cc)),
        ...anchorPool,
        ...phrasePool,
        "a date",
        "a place",
        "a name",
      ]).filter((x) => x && x !== key);

      const promptStd =
        levelAtMost(level, "A2")
          ? `${c.label}: Which word/phrase do you hear?`
          : `${c.label}: Which detail is mentioned?`;
      const promptAdp =
        levelAtMost(level, "A2")
          ? `${c.label}: Which word/phrase do you hear? (Look at the options first.)`
          : `${c.label}: Which detail is mentioned? (Look at the options first.)`;

      const adaptedCount =
        levelAtMost(level, "A1") ? 2 :
        levelAtMost(level, "A2") ? 3 :
        levelAtMost(level, "B1") ? 3 : 4;

      activities.push(
        makeMcq(
          `d${i + 1}`,
          c.id,
          promptStd,
          promptAdp,
          key,
          distractors,
          correctLetter,
          adaptedCount
        )
      );
    }
  }

  // 3) True / False (optional)
  if (allowTrueFalse && chunks.length) {
    const n = levelAtMost(level, "A2") ? 2 : 3;
    for (let i = 0; i < Math.min(n, chunks.length); i++) {
      const c = chunks[i];
      const trueKey = pickChunkKey(c);
      const other = chunks[(i + 1) % chunks.length];
      const falseKey = pickChunkKey(other);

      const isFalse = i === 0 && chunks.length >= 2; // one deliberate false statement first
      const phrase = isFalse ? falseKey : trueKey;
      const ans: "T" | "F" = isFalse ? "F" : "T";

      const statement = levelAtMost(level, "A2")
        ? `${c.label}: You hear "${phrase}".`
        : `${c.label}: The speaker mentions "${phrase}".`;

      activities.push(makeTf(`tf${i + 1}`, c.id, statement, ans));
    }
  }

  // 4) Ordering (text structure)
  if (allowOrder && chunks.length >= 3 && levelAtLeast(level, "A2")) {
    const n = levelAtMost(level, "A2") ? 3 : 4;
    const orderItems = chunks.slice(0, n).map((c) => c.label);
    activities.push(makeOrder("order1", orderItems, "Use the chunk labels as a guide."));
  }

  // 5) Match (vocab/anchors)
  if (allowMatch && chunks.length >= 3) {
    const picks: { anchor: string; chunkLabel: string }[] = [];
    for (let i = 0; i < chunks.length && picks.length < 4; i++) {
      const c = chunks[i];
      const a = pickChunkKey(c);
      if (!a) continue;
      if (picks.some((p) => p.anchor === a)) continue;
      picks.push({ anchor: a, chunkLabel: c.label });
    }
    if (picks.length >= 3) activities.push(makeMatchAnchorsToChunks("match1", picks));
  }

  // 6) Summary (mapped from cloze/gap-fill at lower friction)
  if (allowSummary && levelAtLeast(level, "A2")) {
    const summaryCorrect = `Best summary: ${cleanSnippet(chunks.map((c) => c.text).join(" "), 80)}`;
    const summaryDistractors = [
      "Best summary: It focuses only on numbers and statistics.",
      "Best summary: It is mainly a set of instructions to follow.",
      "Best summary: It is mostly a personal diary entry about feelings.",
    ];
    const correctLetter = ALL_LETTERS[(chunks.length + 1) % 4];
    const adaptedCount = levelAtMost(level, "A2") ? 2 : 3;

    const sum = makeMcq(
      "summary",
      undefined,
      "Choose the best summary.",
      "Choose the best summary. (You can listen again.)",
      summaryCorrect,
      summaryDistractors,
      correctLetter,
      adaptedCount
    );
    sum.type = "summary_mcq";
    activities.push(sum);
  }

// Make sure IDs are stable-ish and sequential in display
  const pack: ListeningPack = {
    meta: {
      title: title || "Listening Focus",
      level,
      textType,
      createdAtISO: new Date().toISOString(),
    },
    audio: {
      mode: audioMode,
      voiceHint: "en-GB",
      url: audioMode === "url" ? audioUrl : undefined,
    },
    chunks,
    activities,
  };

  return pack;
}


/* ---------------------- Listening HTML (Interactive) ---------------------- */

function buildListeningFocusHtml(pack: ListeningPack) {
  const packJson = safeSerializeForHtml(pack);

  // NOTE: use "\n" in script strings; never embed real newlines inside quotes.
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Aontas 10 — Listening Focus</title>
  <style>
    :root{
      --bg:#0b1220; --panel:#0f1b33; --card:#0c1730;
      --text:#e7eefc; --muted:#a7b4d6; --line:rgba(255,255,255,.12);
      --good:#22c55e; --bad:#ef4444; --accent:#38bdf8;
      --shadow: 0 10px 30px rgba(0,0,0,.35);
      --r:16px;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    }
    body{ margin:0; background:linear-gradient(180deg, #060a14, var(--bg)); color:var(--text); }
    .wrap{ max-width:1100px; margin:0 auto; padding:18px 16px 60px; }
    .topbar{ display:flex; gap:12px; flex-wrap:wrap; align-items:center; justify-content:space-between; }
    .brand{ display:flex; gap:12px; align-items:center; }
    .badge{ padding:6px 10px; border:1px solid var(--line); border-radius:999px; color:var(--muted); font-size:12px;}
    h1{ font-size:20px; margin:0; letter-spacing:.2px;}
    .sub{ color:var(--muted); font-size:13px; margin-top:4px;}
    .grid{ display:grid; grid-template-columns: 1.2fr .8fr; gap:14px; margin-top:14px;}
    @media (max-width: 980px){ .grid{ grid-template-columns:1fr; } }
    .panel{ background:rgba(15,27,51,.7); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); overflow:hidden; }
    .panel-h{ padding:14px 14px 12px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; gap:10px;}
    .panel-b{ padding:14px; }
    .row{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .btn{ cursor:pointer; border:1px solid var(--line); background:rgba(255,255,255,.06); color:var(--text); padding:9px 12px; border-radius:12px; font-weight:600; font-size:13px;}
    .btn:hover{ background:rgba(255,255,255,.10); }
    .btn.primary{ border-color: rgba(56,189,248,.55); background: rgba(56,189,248,.14); }
    .btn.good{ border-color: rgba(34,197,94,.55); background: rgba(34,197,94,.14); }
    .btn.bad{ border-color: rgba(239,68,68,.55); background: rgba(239,68,68,.12); }
    .select{ padding:9px 12px; border-radius:12px; border:1px solid var(--line); background:rgba(255,255,255,.06); color:var(--text); }
    .tiny{ font-size:12px; color:var(--muted); }
    .chip{ display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:999px; border:1px solid var(--line); background:rgba(255,255,255,.05); font-size:12px; color:var(--muted); }
    .anchors{ display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;}
    .anchor{ padding:6px 10px; border-radius:999px; border:1px dashed rgba(56,189,248,.5); color:rgba(56,189,248,.9); font-size:12px; }
    .chunklist{ display:flex; flex-direction:column; gap:10px; }
    .chunk{ border:1px solid var(--line); border-radius:14px; padding:12px; background:rgba(12,23,48,.75); }
    .chunk-top{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .chunk-label{ font-weight:800; }
    .chunk-text{ color:var(--muted); font-size:13px; margin-top:10px; line-height:1.55;}
    .hideText .chunk-text{ filter: blur(6px); opacity:.7; user-select:none; }
    .activity{ border:1px solid var(--line); border-radius:14px; padding:14px; background:rgba(12,23,48,.75); }
    .q{ font-weight:800; margin-bottom:10px; line-height:1.3;}
    .optgrid{ display:grid; gap:10px; grid-template-columns: repeat(2, minmax(0,1fr)); }
    @media (max-width: 700px){ .optgrid{ grid-template-columns:1fr; } }
    .opt{ border:1px solid var(--line); border-radius:14px; padding:12px; background:rgba(255,255,255,.05); cursor:pointer; }
    .opt:hover{ background:rgba(255,255,255,.09); }
    .opt-id{ display:inline-block; width:26px; height:26px; border-radius:999px; border:1px solid var(--line); text-align:center; line-height:26px; margin-right:10px; color:var(--muted); font-weight:900;}
    .feedback{ margin-top:10px; font-weight:800; }
    .feedback.good{ color:var(--good); }
    .feedback.bad{ color:var(--bad); }
    .stepper{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:10px;}
    .progress{ height:10px; border-radius:999px; background:rgba(255,255,255,.06); border:1px solid var(--line); overflow:hidden;}
    .bar{ height:100%; width:0%; background:linear-gradient(90deg, var(--good), var(--accent)); transition: width .2s ease;}
    .lost{ border:1px dashed rgba(255,255,255,.25); border-radius:14px; padding:12px; background:rgba(255,255,255,.04); margin-top:10px;}
    .lost h3{ margin:0 0 8px; font-size:14px;}
    .lost .mini{ color:var(--muted); font-size:12px; line-height:1.45;}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <div>
          <h1 id="title">Listening Focus</h1>
          <div class="sub" id="subtitle">Inclusive listening • chunked • repair-friendly</div>
        </div>
        <span class="badge" id="levelBadge">CEFR</span>
      </div>
      <div class="row">
        <button class="btn" id="toggleTeacher">Teacher panel</button>
        <button class="btn" id="toggleText">🙈 Hide text</button>
      </div>
    </div>

    <div class="grid">
      <section class="panel" id="mainPanel">
        <div class="panel-h">
          <div>
            <div style="font-weight:900;">Student tasks</div>
            <div class="tiny" id="taskHint">One question at a time • supports adjustable</div>
          </div>
          <div class="row">
            <label class="chip">Mode
              <select class="select" id="modeSelect">
                <option value="standard">Standard</option>
                <option value="adapted">Adapted</option>
              </select>
            </label>
            <label class="chip">Support
              <select class="select" id="supportSelect">
                <option value="challenge">Challenge</option>
                <option value="supported" selected>Supported</option>
                <option value="readalong">Read-along</option>
              </select>
            </label>
          </div>
        </div>
        <div class="panel-b">
          <div class="row" style="margin-bottom:10px;">
            <button class="btn primary" id="playChunk">▶ Play chunk</button>
            <button class="btn" id="replay3">⟲ 3s</button>
            <button class="btn" id="replayChunk">⟲ Chunk</button>
            <label class="chip">Speed
              <select class="select" id="rateSelect">
                <option value="0.75">Slow</option>
                <option value="0.90">Softer</option>
                <option value="1.00" selected>Normal</option>
                <option value="1.10">Fast</option>
              </select>
            </label>
          </div>

          <div id="audioWrap" style="display:none; margin-bottom:10px;">
            <audio id="audioEl" controls style="width:100%;"></audio>
            <div class="tiny" id="audioNote" style="margin-top:6px;"></div>
          </div>

          <div class="progress" aria-label="Progress">
            <div class="bar" id="bar"></div>
          </div>

          <div style="height:12px;"></div>

          <div class="activity" id="activityCard">
            <div class="q" id="qText">Loading…</div>
            <div class="optgrid" id="options"></div>
            <div class="feedback" id="feedback" style="display:none;"></div>

            <div class="lost">
              <div class="row" style="justify-content:space-between;">
                <h3 style="margin:0;">Got lost?</h3>
                <button class="btn" id="recoveryBtn">Repair loop</button>
              </div>
              <div class="mini" id="recoveryArea">Replay and rejoin without panic. Use this if you missed a piece.</div>
            </div>

            <div class="stepper">
              <button class="btn" id="prevBtn">← Prev</button>
              <div class="tiny" id="stepLabel">0/0</div>
              <button class="btn" id="nextBtn">Next →</button>
            </div>
          </div>
        </div>
      </section>

      <aside class="panel" id="teacherPanel" style="display:none;">
        <div class="panel-h">
          <div>
            <div style="font-weight:900;">Teacher panel</div>
            <div class="tiny">Controls that reduce working-memory load</div>
          </div>
        </div>
        <div class="panel-b">
          <div class="row" style="margin-bottom:10px;">
            <label class="chip"><input type="checkbox" id="oneAtATime" checked/> One question</label>
            <label class="chip"><input type="checkbox" id="autoPause" checked/> Auto-pause</label>
            <label class="chip"><input type="checkbox" id="showAnchors" checked/> Pin anchors</label>
          </div>
          <div class="tiny" style="line-height:1.5;">
            Suggestion: First listen for gist (Challenge), then details (Supported), then confirm (Read-along).
          </div>

          <div style="height:12px;"></div>

          <div class="chunklist" id="chunkList"></div>
        </div>
      </aside>
    </div>
  </div>

<script>
(function(){
  var pack = ${packJson};

  var titleEl = document.getElementById("title");
  var levelBadge = document.getElementById("levelBadge");
  titleEl.textContent = pack.meta.title || "Listening Focus";
  levelBadge.textContent = "CEFR " + pack.meta.level;

  var modeSelect = document.getElementById("modeSelect");
  var supportSelect = document.getElementById("supportSelect");
  var rateSelect = document.getElementById("rateSelect");

  var toggleTeacher = document.getElementById("toggleTeacher");
  var teacherPanel = document.getElementById("teacherPanel");
  var mainPanel = document.getElementById("mainPanel");

  var toggleText = document.getElementById("toggleText");

  var qText = document.getElementById("qText");
  var optionsEl = document.getElementById("options");
  var feedbackEl = document.getElementById("feedback");
  var stepLabel = document.getElementById("stepLabel");
  var bar = document.getElementById("bar");

  var prevBtn = document.getElementById("prevBtn");
  var nextBtn = document.getElementById("nextBtn");

  var playChunkBtn = document.getElementById("playChunk");
  var replay3Btn = document.getElementById("replay3");
  var replayChunkBtn = document.getElementById("replayChunk");

  var audioWrap = document.getElementById("audioWrap");
  var audioEl = document.getElementById("audioEl");
  var audioNote = document.getElementById("audioNote");
  var stopTimer = null;

  var recoveryBtn = document.getElementById("recoveryBtn");
  var recoveryArea = document.getElementById("recoveryArea");

  var oneAtATime = document.getElementById("oneAtATime");
  var autoPause = document.getElementById("autoPause");
  var showAnchors = document.getElementById("showAnchors");

  var chunkList = document.getElementById("chunkList");

  var state = {
    activityIndex: 0,
    currentChunkIndex: 0,
    answers: {}, // activityId -> user answer
    lastSpokenChunkIndex: 0,
    hideText: false
  };

  function getMode(){ return modeSelect.value; }

  function findChunkIndexById(id){
    for(var i=0;i<pack.chunks.length;i++){
      if(pack.chunks[i].id === id) return i;
    }
    return 0;
  }

  function setChunkIndexFromActivity(act){
    if(act.chunkId){
      state.currentChunkIndex = findChunkIndexById(act.chunkId);
    }
  }

  function setProgress(){
    var total = pack.activities.length;
    var done = 0;
    for(var i=0;i<pack.activities.length;i++){
      if(state.answers[pack.activities[i].id] != null) done++;
    }
    stepLabel.textContent = (state.activityIndex+1) + "/" + total + " • " + done + " answered";
    bar.style.width = (total ? (done/total)*100 : 0) + "%";
  }

  function clearFeedback(){
    feedbackEl.style.display = "none";
    feedbackEl.textContent = "";
    feedbackEl.className = "feedback";
  }

  function renderActivity(){
    clearFeedback();
    var act = pack.activities[state.activityIndex];
    if(!act) return;

    setChunkIndexFromActivity(act);

    var side = act[getMode()];
    qText.textContent = side.prompt || "(no prompt)";
    optionsEl.innerHTML = "";

    // Anchor display
    var chunk = pack.chunks[state.currentChunkIndex];
    var anchors = (chunk && chunk.anchors) ? chunk.anchors : [];
    var anchorsHtml = "";
    if(showAnchors.checked && anchors.length){
      anchorsHtml = '<div class="anchors">' + anchors.map(function(a){ return '<span class="anchor">'+a+'</span>' }).join("") + "</div>";
    }

    // Transcript visibility logic by support level
    var showText = (supportSelect.value === "readalong");
    var chunkTextHtml = "";
    if(chunk){
      var txt = chunk.text || "";
      chunkTextHtml = '<div class="chunk-text" id="chunkText">' + escapeHtml(txt) + "</div>";
    }

    // For MCQ types
    if(side.options && side.options.length){
      side.options.forEach(function(opt){
        var d = document.createElement("div");
        d.className = "opt";
        d.setAttribute("data-opt", opt.id);
        d.innerHTML = '<span class="opt-id">'+opt.id+'</span>' + escapeHtml(opt.text);
        d.addEventListener("click", function(){
          state.answers[act.id] = opt.id;
          checkAnswer(act, opt.id);
          setProgress();
        });
        optionsEl.appendChild(d);
      });
    } else if (act.type === "detail_tf") {
      ["T","F"].forEach(function(v){
        var d = document.createElement("div");
        d.className = "opt";
        d.setAttribute("data-opt", v);
        d.innerHTML = '<span class="opt-id">'+v+'</span>' + (v==="T" ? "True" : "False");
        d.addEventListener("click", function(){
          state.answers[act.id] = v;
          checkAnswer(act, v);
          setProgress();
        });
        optionsEl.appendChild(d);
      });
    } else if (act.type === "order") {
      // Simple order UI: click items to build order
      var picked = [];
      var items = (side.items || []).slice();
      var inst = document.createElement("div");
      inst.className = "tiny";
      inst.textContent = "Tap items in the order you heard them.";
      optionsEl.appendChild(inst);

      items.forEach(function(it){
        var d = document.createElement("div");
        d.className = "opt";
        d.innerHTML = '<span class="opt-id">•</span>' + escapeHtml(it);
        d.addEventListener("click", function(){
          if(picked.indexOf(it) !== -1) return;
          picked.push(it);
          d.style.opacity = ".55";
          d.style.pointerEvents = "none";
          if(picked.length === items.length){
            state.answers[act.id] = picked.slice();
            checkAnswer(act, picked);
            setProgress();
          }
        });
        optionsEl.appendChild(d);
      });
    } else if (act.type === "match") {
      // Minimal match UI (dropdown per left item)
      var left = side.left || [];
      var right = side.right || [];
      var selections = new Array(left.length).fill(-1);

      left.forEach(function(l, idx){
        var row = document.createElement("div");
        row.className = "opt";
        var sel = document.createElement("select");
        sel.className = "select";
        var opt0 = document.createElement("option");
        opt0.value = "-1";
        opt0.textContent = "Choose";
        sel.appendChild(opt0);
        right.forEach(function(r, j){
          var o = document.createElement("option");
          o.value = String(j);
          o.textContent = (j+1) + ". " + r;
          sel.appendChild(o);
        });
        sel.addEventListener("change", function(){
          selections[idx] = parseInt(sel.value, 10);
          if(selections.every(function(x){ return x>=0; })){
            state.answers[act.id] = selections.slice();
            checkAnswer(act, selections);
            setProgress();
          }
        });
        row.innerHTML = '<span class="opt-id">'+(idx+1)+'</span>' + escapeHtml(l) + "<div style='height:8px;'></div>";
        row.appendChild(sel);
        optionsEl.appendChild(row);
      });
    } else {
      var d = document.createElement("div");
      d.className = "tiny";
      d.textContent = "This activity type isn't rendered yet in the interactive view.";
      optionsEl.appendChild(d);
    }

    // append chunk info under options
    var footer = document.createElement("div");
    footer.className = "chunk";
    footer.style.marginTop = "12px";
    footer.innerHTML = '<div class="chunk-top"><div class="chunk-label">'+escapeHtml(chunk ? chunk.label : "Chunk")+'</div></div>'
      + (showText ? chunkTextHtml : '')
      + anchorsHtml;

    optionsEl.appendChild(footer);

    setProgress();
  }

  function checkAnswer(act, given){
    var correct = act.answer;
    var ok = false;
    if(Array.isArray(correct)){
      ok = JSON.stringify(correct) === JSON.stringify(given);
    } else {
      ok = String(correct) === String(given);
    }
    feedbackEl.style.display = "block";
    feedbackEl.textContent = ok ? "Correct ✅" : "Not yet — try again.";
    feedbackEl.className = "feedback " + (ok ? "good" : "bad");
  }

  // --- TTS helpers ---
    function clearStopTimer(){
    if(stopTimer){
      clearTimeout(stopTimer);
      stopTimer = null;
    }
  }

  function ensureChunkTimes(){
    if(!audioEl) return;
    if(!(pack.audio && pack.audio.mode === "url")) return;
    if(!isFinite(audioEl.duration) || audioEl.duration <= 0) return;

    // If timestamps aren't provided, approximate by splitting duration evenly.
    var need = false;
    for(var i=0;i<pack.chunks.length;i++){
      if(pack.chunks[i].startSec == null || pack.chunks[i].endSec == null){ need = true; break; }
    }
    if(!need) return;

    var seg = audioEl.duration / Math.max(1, pack.chunks.length);
    for(var j=0;j<pack.chunks.length;j++){
      pack.chunks[j].startSec = j * seg;
      pack.chunks[j].endSec = (j+1) * seg;
    }
    if(audioNote){
      audioNote.textContent = "Note: Chunk playback is approximate unless timestamps are provided.";
    }
  }

function speak(text){
    if(pack.audio.mode !== "tts") return;
    if(!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();

    var u = new SpeechSynthesisUtterance(text);
    var r = parseFloat(rateSelect.value || "1.0");
    u.rate = isFinite(r) ? r : 1.0;

    // Attempt best-match voice hint
    var hint = (pack.audio.voiceHint || "").toLowerCase();
    var voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
    if(voices && voices.length && hint){
      for(var i=0;i<voices.length;i++){
        var v = voices[i];
        var label = (v.name + " " + v.lang).toLowerCase();
        if(label.indexOf(hint) !== -1){ u.voice = v; break; }
      }
    }
    window.speechSynthesis.speak(u);
  }

  function playCurrentChunk(){
    var c = pack.chunks[state.currentChunkIndex];
    if(!c) return;
    state.lastSpokenChunkIndex = state.currentChunkIndex;

    clearStopTimer();

    if(pack.audio && pack.audio.mode === "url" && audioEl){
      ensureChunkTimes();
      if(c.startSec != null && isFinite(c.startSec)){
        audioEl.currentTime = Math.max(0, c.startSec);
      }
      audioEl.play();

      if(autoPause.checked && c.endSec != null && isFinite(c.endSec) && c.startSec != null){
        var ms = Math.max(0, (c.endSec - c.startSec) * 1000);
        stopTimer = setTimeout(function(){ audioEl.pause(); }, ms);
      }
      return;
    }

    // TTS fallback
    speak(c.text);
  }

  function replayChunk(){
    state.currentChunkIndex = state.lastSpokenChunkIndex;
    if(pack.audio && pack.audio.mode === "url" && audioEl){
      // If we have timestamps, jump back to chunk start; otherwise just replay from current time.
      var c = pack.chunks[state.currentChunkIndex];
      if(c && c.startSec != null && isFinite(c.startSec)){
        audioEl.currentTime = Math.max(0, c.startSec);
      }
    }
    playCurrentChunk();
  }

  // "replay last 3 seconds" isn't doable reliably with Web Speech API,
  // so we approximate: replay the full chunk (teacher-friendly, predictable).
  function replay3(){
    if(pack.audio && pack.audio.mode === "url" && audioEl){
      clearStopTimer();
      audioEl.currentTime = Math.max(0, (audioEl.currentTime || 0) - 3);
      audioEl.play();
      return;
    }
    replayChunk();
  }

  // --- Recovery loop (inclusive design) ---
  function runRecovery(){
    var c = pack.chunks[state.currentChunkIndex];
    if(!c){ return; }
    var txt = c.text || "";
    var anchors = (c.anchors || []).slice(0,4);
    var hint = anchors.length ? ("Anchors: " + anchors.join(", ")) : "Focus: try to catch one key word, then rebuild meaning.";
    recoveryArea.innerHTML =
      "<div class='mini'><b>Step 1:</b> Replay chunk.</div>" +
      "<div class='mini'><b>Step 2:</b> " + escapeHtml(hint) + "</div>" +
      "<div class='mini'><b>Step 3:</b> If still stuck, switch Support → Read-along (temporary).</div>";
    playCurrentChunk();
  }

  // Teacher panel chunk list
  function renderChunkList(){
    chunkList.innerHTML = "";
    pack.chunks.forEach(function(c, idx){
      var div = document.createElement("div");
      div.className = "chunk";
      div.innerHTML =
        '<div class="chunk-top">' +
          '<div class="chunk-label">' + escapeHtml(c.label) + '</div>' +
          '<button class="btn" data-idx="'+idx+'">▶ Play</button>' +
        "</div>" +
        '<div class="tiny">' + (c.anchors && c.anchors.length ? ("Anchors: " + c.anchors.join(", ")) : "") + "</div>" +
        '<div class="chunk-text">' + escapeHtml(c.text) + "</div>";
      div.querySelector("button").addEventListener("click", function(){
        state.currentChunkIndex = idx;
        playCurrentChunk();
      });
      chunkList.appendChild(div);
    });
  }

  function escapeHtml(s){
    return String(s)
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;")
      .replace(/'/g,"&#039;");
  }

  // Events
  prevBtn.addEventListener("click", function(){
    state.activityIndex = Math.max(0, state.activityIndex - 1);
    renderActivity();
  });
  nextBtn.addEventListener("click", function(){
    state.activityIndex = Math.min(pack.activities.length - 1, state.activityIndex + 1);
    renderActivity();
  });

  playChunkBtn.addEventListener("click", function(){
    playCurrentChunk();
    if(autoPause.checked){
      // Nothing to do; TTS is already "atomic". Kept for future audio-url chunking.
    }
  });
  replayChunkBtn.addEventListener("click", replayChunk);
  replay3Btn.addEventListener("click", replay3);

  recoveryBtn.addEventListener("click", runRecovery);

  toggleTeacher.addEventListener("click", function(){
    var shown = teacherPanel.style.display !== "none";
    teacherPanel.style.display = shown ? "none" : "flex";
  });

  toggleText.addEventListener("click", function(){
    state.hideText = !state.hideText;
    document.body.classList.toggle("hideText", state.hideText);
    toggleText.textContent = state.hideText ? "👀 Show text" : "🙈 Hide text";
  });

  modeSelect.addEventListener("change", renderActivity);
  supportSelect.addEventListener("change", renderActivity);
  showAnchors.addEventListener("change", renderActivity);

  // Init
  if(pack.audio && pack.audio.mode === "url" && pack.audio.url && audioEl && audioWrap){
    audioEl.src = pack.audio.url;
    audioWrap.style.display = "block";
    if(audioNote){ audioNote.textContent = "Audio mode: URL (use teacher controls for pacing)."; }
    // Try to compute approximate chunk boundaries once metadata is loaded.
    audioEl.addEventListener("loadedmetadata", function(){ ensureChunkTimes(); });
    // Update button labels to avoid promising true chunked playback without timestamps.
    playChunkBtn.textContent = "▶ Play audio";
  }

  renderChunkList();
  renderActivity();
})();
</script>
</body>
</html>`;
}

/* --------------------- Listening PDFs (Printables) ------------------------ */

function pdfAddWrapped(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number
) {
  const lines = doc.splitTextToSize(text, maxWidth);
  doc.text(lines, x, y);
  return y + lines.length * lineHeight;
}

function buildListeningStudentPdf(
  pack: ListeningPack,
  mode: "standard" | "adapted"
): Blob {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const adapted = mode === "adapted";
  const margin = adapted ? 12 : 14;
  const fsTitle = adapted ? 18 : 16;
  const fsH2 = adapted ? 13 : 12;
  const fsBody = adapted ? 11 : 10;
  const fsSmall = adapted ? 10 : 9;
  const lh = adapted ? 5.8 : 4.8;
  const lhTight = adapted ? 5.4 : 4.6;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const maxW = pageW - margin * 2;

  let y = margin;

  doc.setFontSize(fsTitle);
  doc.text(`Listening Focus — ${pack.meta.title}`, margin, y);
  y += adapted ? 8 : 7;

  doc.setFontSize(11);
  doc.text(`CEFR: ${pack.meta.level} • Version: ${mode.toUpperCase()}`, margin, y);
  y += adapted ? 7 : 6;

  doc.setFontSize(fsBody);
  y = pdfAddWrapped(
    doc,
    "Instructions: Listen in chunks. Answer the questions. If you get lost, ask for a replay of the last chunk.",
    margin,
    y,
    maxW,
    4.6
  );
  y += adapted ? 3 : 2;

  doc.setDrawColor(180);
  doc.line(margin, y, pageW - margin, y);
  y += adapted ? 7 : 6;

  const addPageIfNeeded = (extra = 12) => {
    if (y + extra > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  pack.activities.forEach((act, idx) => {
    addPageIfNeeded(22);

    const side = act[mode];
    doc.setFontSize(fsH2);
    doc.text(`Activity ${idx + 1}`, margin, y);
    y += adapted ? 7 : 6;

    doc.setFontSize(fsBody);
    const chunkLabel = act.chunkId
      ? pack.chunks.find((c) => c.id === act.chunkId)?.label
      : "";
    const header = chunkLabel ? `${chunkLabel}: ${side.prompt}` : side.prompt;
    y = pdfAddWrapped(doc, header, margin, y, maxW, lh);
    y += adapted ? 3 : 2;

    // MCQ
    if (side.options && side.options.length) {
      side.options.forEach((o) => {
        addPageIfNeeded(8);
        y = pdfAddWrapped(doc, `(${o.id}) ${o.text}`, margin + 2, y, maxW - 2, lhTight);
      });
      y += 1;
    } else if (act.type === "detail_tf") {
      y = pdfAddWrapped(doc, "(T) True    (F) False", margin + 2, y, maxW, lhTight);
      y += 1;
    } else if (act.type === "order" && side.items && side.items.length) {
      y = pdfAddWrapped(doc, "Write the order number next to each item:", margin + 2, y, maxW, lhTight);
      y += 1;
      side.items.forEach((it) => {
        addPageIfNeeded(8);
        y = pdfAddWrapped(doc, "___  " + it, margin + 6, y, maxW - 6, lhTight);
      });
      y += 1;
    } else if (act.type === "match" && side.left && side.right) {
      y = pdfAddWrapped(doc, "Match:", margin + 2, y, maxW, lhTight);
      y += 1;
      const left = side.left;
      const right = side.right;
      left.forEach((l, i2) => {
        addPageIfNeeded(8);
        y = pdfAddWrapped(doc, `${i2 + 1}. ${l}   →   ____`, margin + 6, y, maxW - 6, lhTight);
      });
      y += 1;
      addPageIfNeeded(10);
      doc.setFontSize(fsSmall);
      y = pdfAddWrapped(
        doc,
        "Options: " + right.map((r, j) => `${j + 1}. ${r}`).join("   "),
        margin + 6,
        y,
        maxW - 6,
        4.2
      );
      doc.setFontSize(fsBody);
      y += adapted ? 3 : 2;
    } else {
      y = pdfAddWrapped(doc, "(This item is interactive-only.)", margin + 2, y, maxW, lhTight);
      y += 1;
    }

    y += 4;
  });

  return doc.output("blob");
}

function buildListeningTeacherKeyPdf(pack: ListeningPack): Blob {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const margin = 14;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const maxW = pageW - margin * 2;

  let y = margin;

  doc.setFontSize(16);
  doc.text(`Teacher Key — Listening Focus`, margin, y);
  y += 7;

  doc.setFontSize(11);
  doc.text(`${pack.meta.title} • CEFR ${pack.meta.level}`, margin, y);
  y += 6;

  doc.setFontSize(10);
  y = pdfAddWrapped(
    doc,
    "Answer key is shared across Standard and Adapted. Use the repair loop: replay last chunk + anchors; only reveal transcript if needed.",
    margin,
    y,
    maxW,
    4.6
  );
  y += 4;

  const addPageIfNeeded = (extra = 12) => {
    if (y + extra > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  // Chunks with transcript
  doc.setFontSize(12);
  doc.text("Chunks (transcript)", margin, y);
  y += 6;
  doc.setFontSize(10);

  pack.chunks.forEach((c) => {
    addPageIfNeeded(18);
    doc.setFontSize(11);
    doc.text(`${c.label}`, margin, y);
    y += 5;

    doc.setFontSize(9);
    if (c.anchors && c.anchors.length) {
      y = pdfAddWrapped(doc, `Anchors: ${c.anchors.join(", ")}`, margin, y, maxW, 4.2);
      y += 1;
    }
    y = pdfAddWrapped(doc, c.text, margin, y, maxW, 4.2);
    y += 4;
  });

  addPageIfNeeded(16);
  doc.setDrawColor(180);
  doc.line(margin, y, pageW - margin, y);
  y += 6;

  // Answers
  doc.setFontSize(12);
  doc.text("Answers", margin, y);
  y += 6;
  doc.setFontSize(10);

  pack.activities.forEach((act, idx) => {
    addPageIfNeeded(14);
    const chunkLabel = act.chunkId
      ? pack.chunks.find((c) => c.id === act.chunkId)?.label
      : "";

    doc.setFontSize(10);
    doc.text(`Activity ${idx + 1}${chunkLabel ? " (" + chunkLabel + ")" : ""}:`, margin, y);
    y += 5;

    let answerText = "";
    if (Array.isArray(act.answer)) {
      // order or match
      if (act.type === "order") {
        answerText = "Order: " + (act.answer as string[]).join(" → ");
      } else if (act.type === "match") {
        const arr = act.answer as number[];
        answerText = "Match: " + arr.map((ri, i2) => `${i2 + 1}→${ri + 1}`).join(", ");
      } else {
        answerText = JSON.stringify(act.answer);
      }
    } else {
      // MCQ / TF
      if (act.type === "detail_tf") {
        answerText = act.answer === "T" ? "True" : "False";
      } else {
        answerText = `Option: ${act.answer}`;
      }
    }

    y = pdfAddWrapped(doc, answerText, margin + 2, y, maxW - 2, 4.6);
    y += 3;
  });

  return doc.output("blob");
}

/* --------------------- Reading HTML (Deluxe Interactive) ----------------- */

function buildReadingInteractiveHtml(args: {
  title: string;
  level: Level;
  standardText: string;
  adaptedText: string;
  exercises: ExerciseItem[];
}) {
  const payload = safeSerializeForHtml({
    title: args.title,
    level: args.level,
    reading: { standard: args.standardText, adapted: args.adaptedText },
    exercises: args.exercises || [],
  });

  // Deluxe reading export:
  // - Read-aloud (SpeechSynthesis) + voice chooser + speed
  // - Dyslexia tools (font size, line/letter spacing, tint, focus ruler, bionic)
  // - Select text → quick tools: pronounce, add to vocab, lookup, translate, images
  // - Vocab & Pronunciation Lab: word bank + small “listen & choose” retrieval game
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Aontas 10 — Reading Pack</title>
<style>
  :root{
    --bg:#0b1220;--panel:#0f1b33;--text:#e7eefc;--muted:#a7b4d6;--line:rgba(255,255,255,.12);
    --good:#22c55e;--bad:#ef4444;--warn:#f59e0b;
    --fs:18px; --lh:1.65; --ls:0px; --ws:0px; --tint:rgba(255,255,255,0);
  }
  *{box-sizing:border-box}
  body{margin:0;background:linear-gradient(180deg,#060a14,var(--bg));color:var(--text);
       font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;}
  .wrap{max-width:1040px;margin:0 auto;padding:18px 14px 60px;}
  .top{display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between;}
  h1{margin:0;font-size:20px;}
  .sub{color:var(--muted);font-size:13px;margin-top:4px;line-height:1.4}
  .panel{margin-top:14px;background:rgba(15,27,51,.78);border:1px solid var(--line);border-radius:18px;overflow:hidden;}
  .ph{padding:12px 14px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}
  .pb{padding:14px;}
  .btn{cursor:pointer;border:1px solid var(--line);background:rgba(255,255,255,.06);color:var(--text);
        padding:9px 12px;border-radius:12px;font-weight:800;font-size:13px;}
  .btn:hover{background:rgba(255,255,255,.10);}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  .select, .range{padding:9px 12px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.06);color:var(--text);}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .pill{border:1px solid var(--line);border-radius:999px;padding:6px 10px;font-size:12px;color:var(--muted);background:rgba(0,0,0,.10)}
  .readingArea{position:relative;border-radius:16px;padding:14px;background:rgba(0,0,0,.10);
               border:1px solid rgba(255,255,255,.08);}
  .tint{position:absolute;inset:0;background:var(--tint);pointer-events:none;border-radius:16px;}
  .p{position:relative;color:var(--text);font-size:var(--fs);line-height:var(--lh);
      letter-spacing:var(--ls);word-spacing:var(--ws);margin:0 0 12px;}
  .speaking{outline:2px solid rgba(99,102,241,.45); background:rgba(99,102,241,.12); border-radius:10px; padding:10px;}
  .q{border:1px solid var(--line);border-radius:14px;padding:12px;margin-bottom:10px;background:rgba(255,255,255,.05);}
  .qtitle{font-weight:900;margin-bottom:10px;}
  .opt{border:1px solid var(--line);border-radius:12px;padding:10px;margin-top:8px;cursor:pointer;background:rgba(0,0,0,.10);}
  .opt:hover{background:rgba(255,255,255,.08);}
  .feedback{margin-top:10px;font-weight:900;}
  .good{color:var(--good);}
  .bad{color:var(--bad);}
  .tabs{display:flex;gap:8px;flex-wrap:wrap}
  .tab{cursor:pointer;padding:8px 10px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.06);font-weight:800;font-size:12px}
  .tab[aria-selected="true"]{background:rgba(99,102,241,.25);border-color:rgba(99,102,241,.55)}
  .labGrid{display:grid;grid-template-columns: 1.3fr .7fr; gap:12px;}
  @media (max-width: 860px){ .labGrid{grid-template-columns: 1fr;} }
  .card{border:1px solid var(--line);border-radius:16px;background:rgba(0,0,0,.10);padding:12px}
  .tiny{font-size:12px;color:var(--muted);line-height:1.35}
  .wordList{display:flex;flex-direction:column;gap:8px;margin-top:10px}
  .word{display:flex;gap:8px;align-items:center;justify-content:space-between;border:1px solid rgba(255,255,255,.10);
        border-radius:14px;padding:10px;background:rgba(255,255,255,.04)}
  .word strong{font-size:14px}
  .kbd{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;border:1px solid var(--line);
       padding:2px 6px;border-radius:8px;color:var(--muted)}
  .ruler{display:none; position:fixed; left:0; right:0; height:54px; pointer-events:none;
          background:linear-gradient(to bottom, rgba(0,0,0,.55), rgba(0,0,0,0)); z-index:50; mix-blend-mode:multiply;}
  .ruler::after{content:""; position:absolute; left:0; right:0; top:22px; height:3px; background:rgba(255,255,255,.18);}
  .pop{display:none; position:fixed; z-index:60; padding:10px; border-radius:16px; border:1px solid var(--line);
        background:rgba(15,27,51,.95); box-shadow:0 10px 30px rgba(0,0,0,.35); max-width:min(560px, calc(100vw - 20px));}
  .pop .title{font-weight:900}
  .pop .actions{margin-top:8px; display:flex; flex-wrap:wrap; gap:8px;}
  .linkbtn{cursor:pointer; border:1px solid var(--line); background:rgba(255,255,255,.06); color:var(--text);
        padding:7px 10px; border-radius:12px; font-weight:800; font-size:12px;}
  .linkbtn:hover{background:rgba(255,255,255,.10)}
  .warn{color:var(--warn)}
</style>
</head>
<body>
<div class="ruler" id="ruler"></div>

<div class="pop" id="pop">
  <div class="title" id="popWord">Word</div>
  <div class="tiny" id="popHint">Quick tools for the selected text.</div>
  <div class="actions">
    <button class="linkbtn" id="popPronounce">🔊 Pronounce</button>
    <button class="linkbtn" id="popAdd">➕ Add to Vocab Lab</button>
    <button class="linkbtn" id="popDefine">📘 Look up</button>
    <button class="linkbtn" id="popTranslate">🌍 Translate</button>
    <button class="linkbtn" id="popImages">🖼️ Images</button>
    <button class="linkbtn" id="popClose">✖</button>
  </div>
  <div class="tiny warn" id="popNet" style="display:none;margin-top:8px;">
    Note: Lookup/Translate/Images open in a new tab and need internet access.
  </div>
</div>

<div class="wrap">
  <div class="top">
    <div>
      <h1 id="title">Reading Pack</h1>
      <div class="sub" id="sub">CEFR</div>
      <div class="sub tiny" style="margin-top:6px;">
        Tip: Select a word/phrase to open quick tools. <span class="kbd">Esc</span> closes the popover.
      </div>
    </div>
    <div class="row">
      <label class="pill">Text view
        <select class="select" id="mode" style="margin-left:8px;">
          <option value="standard">Classic</option>
          <option value="adapted">Spacious</option>
        </select>
      </label>
      <span class="pill" id="teacherPill" style="display:none;">Teacher</span>
      <button class="btn" id="toggleText">🙈 Hide text</button>
    </div>
  </div>

  <section class="panel">
    <div class="ph">
      <div style="font-weight:900;">Read-aloud & Dyslexia Tools</div>
      <div class="row">
        <button class="btn" id="readAll">🔊 Read all</button>
        <button class="btn" id="pause">⏸ Pause</button>
        <button class="btn" id="stop">⏹ Stop</button>
        <label class="pill">Speed
          <input class="range" id="rate" type="range" min="0.7" max="1.25" step="0.05" value="1" style="width:130px; margin-left:8px;">
        </label>
        <select class="select" id="voice" title="Voice"></select>
      </div>
    </div>
    <div class="pb">
      <div class="row" style="margin-bottom:10px;">
        <button class="btn" id="fsDown">A−</button>
        <button class="btn" id="fsUp">A+</button>
        <label class="pill">Line spacing
          <input class="range" id="lh" type="range" min="1.3" max="2.0" step="0.05" value="1.65" style="width:140px; margin-left:8px;">
        </label>
        <label class="pill">Letter spacing
          <input class="range" id="ls" type="range" min="0" max="2" step="0.25" value="0" style="width:140px; margin-left:8px;">
        </label>
        <label class="pill">Background tint
          <select class="select" id="tint" style="margin-left:8px;">
            <option value="none">None</option>
            <option value="cream">Cream</option>
            <option value="blue">Blue</option>
            <option value="green">Green</option>
            <option value="rose">Rose</option>
          </select>
        </label>
        <button class="btn" id="rulerToggle">🎯 Focus ruler</button>
        <button class="btn" id="bionicToggle">🧠 Bionic</button>
        <button class="btn" id="chunkToggle">🧩 One at a time</button>
        <button class="btn" id="chunkPrev" style="display:none;">◀ Prev</button>
        <button class="btn" id="chunkNext" style="display:none;">Next ▶</button>
        <span class="pill" id="chunkInfo" style="display:none;">Paragraph 1/1</span>
      </div>

      <div class="readingArea" id="readingArea">
        <div class="tint"></div>
        <div id="reading"></div>
      </div>

      <div class="tiny" style="margin-top:10px;">
        Read-aloud uses your browser’s speech engine. If voices are missing, try reloading the page.
      </div>
    </div>
  </section>

  <section class="panel">
    <div class="ph">
      <div>
        <div style="font-weight:900;">Exercises</div>
        <div class="sub" style="margin:4px 0 0;">Tap an option to answer. Immediate feedback for MCQs.</div>
        <div id="teacherPanel" class="row" style="display:none; margin-top:10px;">
          <span class="pill">Teacher tools</span>
          <button class="btn" id="teacherAnswers" type="button">✅ Answers</button>
          <button class="btn" id="teacherIds" type="button"># IDs</button>
          <button class="btn" id="teacherLabels" type="button">A/B labels</button>
        </div>
      </div>
      <div id="progress" class="sub">0/0</div>
    </div>
    <div class="pb" id="qs"></div>
  </section>

  <section class="panel">
    <div class="ph">
      <div>
        <div style="font-weight:900;">Vocab & Pronunciation Lab</div>
        <div class="sub" style="margin:4px 0 0;">Build a mini word bank from the text.</div>
      </div>
      <div class="tabs" role="tablist">
        <button class="tab" id="tabVocab" aria-selected="true">Word bank</button>
        <button class="tab" id="tabListen" aria-selected="false">Listen & choose</button>
      </div>
    </div>
    <div class="pb">
      <div class="labGrid">
        <div class="card">
          <div style="font-weight:900;">Saved words</div>
          <div class="tiny">Select text → “Add to Vocab Lab”. Then practise here.</div>
          <div class="row" style="margin-top:10px;">
            <button class="btn" id="suggestVocab" type="button">✨ Suggest for CEFR</button>
          </div>
          <div class="wordList" id="wordList"></div>
          <div class="tiny" style="margin-top:10px;">Shortcut: double-click a word in the reading text to add it.</div>
        </div>

        <div class="card">
          <div style="font-weight:900;">Practice</div>
          <div class="tiny" id="practiceHint">Pick a word from the list, then press “Pronounce”.</div>
          <div style="margin-top:10px;" class="row">
            <button class="btn" id="sayWord">🔊 Pronounce</button>
            <button class="btn" id="saySlow">🐢 Slow</button>
            <button class="btn" id="example">📌 Example</button>
          </div>
          <div class="tiny" style="margin-top:10px;" id="exampleOut"></div>
          <hr style="border:0;border-top:1px solid var(--line);margin:12px 0;">
          <div style="font-weight:900;">Listen & choose</div>
          <div class="tiny">A tiny retrieval game (memory-friendly).</div>
          <div class="row" style="margin-top:10px;">
            <button class="btn" id="startGame">▶ Start</button>
            <button class="btn" id="repeatGame">🔁 Repeat</button>
          </div>
          <div class="tiny" style="margin-top:10px;" id="gameMsg"></div>
          <div id="gameChoices" class="wordList"></div>
        </div>
      </div>

      <div class="tiny" style="margin-top:12px;">
        Note: Microphone-based pronunciation checking needs HTTPS + speech recognition. This lab focuses on <b>hearing + producing</b>.
      </div>
    </div>
  </section>
</div>

<script>
(function(){
  var data = ${payload};

  // Elements
  var modeEl = document.getElementById("mode");
  var readingEl = document.getElementById("reading");
  var qsEl = document.getElementById("qs");
  var progressEl = document.getElementById("progress");
  var titleEl = document.getElementById("title");
  var subEl = document.getElementById("sub");
  var toggleText = document.getElementById("toggleText");

  var readAllBtn = document.getElementById("readAll");
  var pauseBtn = document.getElementById("pause");
  var stopBtn = document.getElementById("stop");
  var rateEl = document.getElementById("rate");
  var voiceEl = document.getElementById("voice");

  var fsDown = document.getElementById("fsDown");
  var fsUp = document.getElementById("fsUp");
  var lhEl = document.getElementById("lh");
  var lsEl = document.getElementById("ls");
  var tintEl = document.getElementById("tint");
  var bionicToggle = document.getElementById("bionicToggle");
  var rulerToggle = document.getElementById("rulerToggle");
  var rulerEl = document.getElementById("ruler");
  var readingArea = document.getElementById("readingArea");

  var chunkToggle = document.getElementById("chunkToggle");
  var chunkPrev = document.getElementById("chunkPrev");
  var chunkNext = document.getElementById("chunkNext");
  var chunkInfo = document.getElementById("chunkInfo");

  var teacherPill = document.getElementById("teacherPill");
  var teacherPanel = document.getElementById("teacherPanel");
  var teacherAnswers = document.getElementById("teacherAnswers");
  var teacherIds = document.getElementById("teacherIds");
  var teacherLabels = document.getElementById("teacherLabels");

  var suggestVocab = document.getElementById("suggestVocab");


  var pop = document.getElementById("pop");
  var popWord = document.getElementById("popWord");
  var popNet = document.getElementById("popNet");
  var popPronounce = document.getElementById("popPronounce");
  var popAdd = document.getElementById("popAdd");
  var popDefine = document.getElementById("popDefine");
  var popTranslate = document.getElementById("popTranslate");
  var popImages = document.getElementById("popImages");
  var popClose = document.getElementById("popClose");

  var tabVocab = document.getElementById("tabVocab");
  var tabListen = document.getElementById("tabListen");
  var wordList = document.getElementById("wordList");
  var sayWord = document.getElementById("sayWord");
  var saySlow = document.getElementById("saySlow");
  var exampleBtn = document.getElementById("example");
  var exampleOut = document.getElementById("exampleOut");
  var practiceHint = document.getElementById("practiceHint");

  var startGame = document.getElementById("startGame");
  var repeatGame = document.getElementById("repeatGame");
  var gameMsg = document.getElementById("gameMsg");
  var gameChoices = document.getElementById("gameChoices");

  // State
  var state = {
    answers: {},
    hide:false,
    bionic:false,
    ruler:false,
    chunk:{ on:false, idx:0 },
    teacher:{ enabled:false, showAnswers:false, showIds:false, showLabels:false },
    vocab: [], // [{ text, kind: "word"|"phrasal"|"collocation" }]
    selectedVocab: null,
    game: { target:null, choices:[] },
  };


  // ---------- tiny helpers ----------
  function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

  function refreshTeacherUi(){
    var on = !!(state.teacher && state.teacher.enabled);
    if(teacherPill) teacherPill.style.display = on ? "inline-flex" : "none";
    if(teacherPanel) teacherPanel.style.display = on ? "flex" : "none";

    if(teacherAnswers) teacherAnswers.textContent = (state.teacher.showAnswers ? "✅ Answers: ON" : "✅ Answers");
    if(teacherIds) teacherIds.textContent = (state.teacher.showIds ? "# IDs: ON" : "# IDs");
    if(teacherLabels) teacherLabels.textContent = (state.teacher.showLabels ? "A/B labels: ON" : "A/B labels");

    if(!on){
      state.teacher.showAnswers = false;
      state.teacher.showIds = false;
      state.teacher.showLabels = false;
      try{
        localStorage.setItem("a10_teacher_answers", "0");
        localStorage.setItem("a10_teacher_ids", "0");
        localStorage.setItem("a10_teacher_labels", "0");
      }catch(e){}
    }
  }

  function toggleTeacher(){
    state.teacher.enabled = !state.teacher.enabled;
    if(!state.teacher.enabled){
      state.teacher.showAnswers = false;
      state.teacher.showIds = false;
      state.teacher.showLabels = false;
    }
    try{ localStorage.setItem("a10_teacher", state.teacher.enabled ? "1" : "0"); }catch(e){}
    refreshTeacherUi();
    renderReading();
    renderQs();
  }
  titleEl.textContent = data.title || "Reading Pack";
  subEl.textContent = "CEFR " + (data.level || "");
  // Restore teacher mode quietly (Ctrl+Shift+T toggles)
  try{
    state.teacher.enabled = localStorage.getItem("a10_teacher") === "1";
    state.teacher.showAnswers = localStorage.getItem("a10_teacher_answers") === "1";
    state.teacher.showIds = localStorage.getItem("a10_teacher_ids") === "1";
    state.teacher.showLabels = localStorage.getItem("a10_teacher_labels") === "1";
  }catch(e){}

  function splitParas(text){
    var t = (text || "").trim();
    if(!t) return [];
    var paras = t.split("\n\n");
    if(paras.length === 1) paras = t.split("\n");
    return paras.map(function(p){ return p.trim(); }).filter(Boolean);
  }

  function escapeHtml(s){
    return (s || "")
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;");
  }

  function bionicify(text){
    return text.split(/(\s+)/).map(function(tok){
      if(!tok || /^\s+$/.test(tok)) return tok;
      var w = tok;
      var m = w.match(/^([\(\[\{{\"'“”‘’]*)([A-Za-zÀ-ÖØ-öø-ÿ-]+)([\)\]\}}\.,;:!?'"“”‘’]*)$/);
      if(!m) return escapeHtml(w);
      var pre = m[1], core = m[2], suf = m[3];
      var cut = Math.max(1, Math.floor(core.length * 0.4));
      return escapeHtml(pre) + "<b>" + escapeHtml(core.slice(0,cut)) + "</b>" + escapeHtml(core.slice(cut)) + escapeHtml(suf);
    }).join("");
  }

  function renderReading(){
    readingEl.innerHTML = "";
    var text = (data.reading && data.reading[modeEl.value]) ? data.reading[modeEl.value] : "";
    var paras = splitParas(text);
    var chunkOn = !!(state.chunk && state.chunk.on);
    if(chunkOn){
      state.chunk.idx = clamp(state.chunk.idx || 0, 0, Math.max(0, paras.length - 1));
      if(chunkInfo) chunkInfo.textContent = "Paragraph " + (state.chunk.idx + 1) + "/" + paras.length;
    }
    paras.forEach(function(p, idx){
      var d = document.createElement("p");
      d.className = "p";
      d.setAttribute("data-idx", String(idx));
      d.innerHTML = state.bionic ? bionicify(p) : escapeHtml(p);
      if(chunkOn) d.style.display = (idx === state.chunk.idx) ? "block" : "none";
      readingEl.appendChild(d);
    });
    readingEl.style.display = state.hide ? "none" : "block";
    if(state.teacher && state.teacher.enabled && state.teacher.showLabels){
      subEl.textContent = "CEFR " + (data.level || "") + " • Classic = Standard • Spacious = Supported";
    } else {
      subEl.textContent = "CEFR " + (data.level || "");
    }
  }

  function updateProgress(){
    var total = (data.exercises || []).length || 0;
    var done = Object.keys(state.answers).length;
    progressEl.textContent = done + "/" + total + " answered";
  }

  function renderQs(){
    qsEl.innerHTML = "";
    var exercises = data.exercises || [];
    exercises.forEach(function(item, idx){
      var side = item[modeEl.value];
      var card = document.createElement("div");
      card.className = "q";

      var head = document.createElement("div");
      head.style.display = "flex";
      head.style.alignItems = "flex-start";
      head.style.justifyContent = "space-between";
      head.style.gap = "10px";

      var title = document.createElement("div");
      title.className = "qtitle";
      title.textContent = (idx+1) + ". " + (side && side.prompt ? side.prompt : "");
      head.appendChild(title);

      var idPill = document.createElement("div");
      idPill.className = "pill";
      idPill.textContent = "ID " + (item.id != null ? String(item.id) : String(idx+1));
      idPill.style.display = (state.teacher && state.teacher.enabled && state.teacher.showIds) ? "inline-flex" : "none";
      head.appendChild(idPill);

      card.appendChild(head);

      var opts = (side && side.options) ? side.options : [];
      if(opts.length){
        opts.forEach(function(opt){
          var o = document.createElement("div");
          o.className = "opt";
          o.textContent = opt;
          o.addEventListener("click", function(){
            state.answers[item.id] = opt;
            var ok = false;
            if(Array.isArray(item.answer)) ok = item.answer.indexOf(opt) !== -1;
            else ok = String(item.answer) === String(opt);

            fb.textContent = ok ? "Correct ✅" : "Not yet — try again.";
            fb.className = "feedback " + (ok ? "good" : "bad");
            updateProgress();
          });
          card.appendChild(o);
        });
      } else {
        var t = document.createElement("div");
        t.className = "sub";
        t.textContent = "Write this answer on paper / in your notebook.";
        card.appendChild(t);
      }

      var fb = document.createElement("div");
      fb.className = "feedback";
      fb.textContent = "";
      card.appendChild(fb);

      var ansBox = document.createElement("div");
      ansBox.className = "tiny";
      ansBox.style.marginTop = "10px";
      var ans = item.answer;
      var ansText = Array.isArray(ans) ? ans.join("; ") : String(ans);
      ansBox.innerHTML = "<b>Answer:</b> " + escapeHtml(ansText);
      ansBox.style.display = (state.teacher && state.teacher.enabled && state.teacher.showAnswers) ? "block" : "none";
      card.appendChild(ansBox);

      qsEl.appendChild(card);
    });
    updateProgress();
  }

  // ---------- Read aloud (SpeechSynthesis) ----------
  function listVoices(){
    var voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    voiceEl.innerHTML = "";
    voices.forEach(function(v, i){
      var opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = v.name + (v.lang ? " ("+v.lang+")" : "");
      voiceEl.appendChild(opt);
    });
    var best = voices.findIndex(function(v){ return /en/i.test(v.lang || ""); });
    if(best >= 0) voiceEl.value = String(best);
  }

  var speakQueue = [];
  var speaking = false;

  function clearSpeakingStyles(){
    var ps = readingEl.querySelectorAll(".p");
    ps.forEach(function(p){ p.classList.remove("speaking"); });
  }

  function speakText(text, onend, rate){
    if(!window.speechSynthesis) return;
    var u = new SpeechSynthesisUtterance(text);
    var voices = window.speechSynthesis.getVoices();
    var idx = parseInt(voiceEl.value || "0", 10);
    if(voices[idx]) u.voice = voices[idx];
    u.rate = rate || parseFloat(rateEl.value || "1");
    u.onend = function(){ onend && onend(); };
    u.onerror = function(){ onend && onend(); };
    window.speechSynthesis.speak(u);
  }

  function readAll(){
    if(!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    clearSpeakingStyles();

    var ps = Array.prototype.slice.call(readingEl.querySelectorAll(".p"));
    speakQueue = ps.map(function(p){ return { idx: parseInt(p.getAttribute("data-idx")||"0",10), text: p.textContent || "" }; });
    speaking = true;

    function next(){
      if(!speaking) return;
      var item = speakQueue.shift();
      if(!item){ speaking = false; clearSpeakingStyles(); return; }
      clearSpeakingStyles();
      var el = readingEl.querySelector('.p[data-idx="'+item.idx+'"]');
      if(el) el.classList.add("speaking");
      speakText(item.text, next);
    }
    next();
  }

  readAllBtn.addEventListener("click", readAll);
  pauseBtn.addEventListener("click", function(){
    if(!window.speechSynthesis) return;
    if(window.speechSynthesis.speaking && !window.speechSynthesis.paused) window.speechSynthesis.pause();
    else if(window.speechSynthesis.paused) window.speechSynthesis.resume();
  });
  stopBtn.addEventListener("click", function(){
    if(!window.speechSynthesis) return;
    speaking = false;
    window.speechSynthesis.cancel();
    clearSpeakingStyles();
  });

  // ---------- Dyslexia-friendly tools ----------
  function setVar(k,v){ document.documentElement.style.setProperty(k, v); }
  fsUp.addEventListener("click", function(){
    var fs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fs")) || 18;
    fs = Math.min(28, fs + 1);
    setVar("--fs", fs + "px");
  });
  fsDown.addEventListener("click", function(){
    var fs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fs")) || 18;
    fs = Math.max(14, fs - 1);
    setVar("--fs", fs + "px");
  });
  lhEl.addEventListener("input", function(){ setVar("--lh", lhEl.value); });
  lsEl.addEventListener("input", function(){ setVar("--ls", lsEl.value + "px"); });
  tintEl.addEventListener("change", function(){
    var v = tintEl.value;
    var map = {
      none: "rgba(255,255,255,0)",
      cream: "rgba(250,240,220,.18)",
      blue: "rgba(140,200,255,.14)",
      green: "rgba(140,255,200,.12)",
      rose: "rgba(255,160,200,.10)"
    };
    setVar("--tint", map[v] || map.none);
  });

  bionicToggle.addEventListener("click", function(){
    state.bionic = !state.bionic;
    bionicToggle.textContent = state.bionic ? "🧠 Bionic: ON" : "🧠 Bionic";
    renderReading();
  });
  function applyChunkUi(){
    var on = !!(state.chunk && state.chunk.on);
    if(chunkPrev) chunkPrev.style.display = on ? "inline-flex" : "none";
    if(chunkNext) chunkNext.style.display = on ? "inline-flex" : "none";
    if(chunkInfo) chunkInfo.style.display = on ? "inline-flex" : "none";
    if(chunkToggle) chunkToggle.textContent = on ? "🧩 One at a time: ON" : "🧩 One at a time";
  }

  function setChunkIndex(i){
    state.chunk.idx = i;
    renderReading();
  }

  if(chunkToggle) chunkToggle.addEventListener("click", function(){
    state.chunk.on = !state.chunk.on;
    state.chunk.idx = clamp(state.chunk.idx || 0, 0, 9999);
    applyChunkUi();
    renderReading();
  });
  if(chunkPrev) chunkPrev.addEventListener("click", function(){
    setChunkIndex(clamp((state.chunk.idx||0) - 1, 0, 9999));
  });
  if(chunkNext) chunkNext.addEventListener("click", function(){
    setChunkIndex(clamp((state.chunk.idx||0) + 1, 0, 9999));
  });


  function setRuler(on){
    state.ruler = on;
    rulerEl.style.display = on ? "block" : "none";
    rulerToggle.textContent = on ? "🎯 Focus ruler: ON" : "🎯 Focus ruler";
  }
  rulerToggle.addEventListener("click", function(){ setRuler(!state.ruler); });
  window.addEventListener("mousemove", function(e){ if(state.ruler) rulerEl.style.top = (e.clientY - 24) + "px"; });
  window.addEventListener("touchmove", function(e){
    if(state.ruler && e.touches && e.touches[0]) rulerEl.style.top = (e.touches[0].clientY - 24) + "px";
  }, {passive:true});

  // ---------- Selection tools + Vocab lab ----------
  function cleanSelectionText(t){
    return (t||"").trim().replace(/\s+/g," ").slice(0, 60);
  }
  function getSelectionText(){
    var s = window.getSelection ? String(window.getSelection()) : "";
    return cleanSelectionText(s);
  }
  function showPop(x,y,text){
    if(!text) return;
    popWord.textContent = text;
    popNet.style.display = "block";
    pop.style.display = "block";
    var pad = 10;
    var w = pop.offsetWidth || 320;
    var h = pop.offsetHeight || 120;
    var left = Math.min(window.innerWidth - w - pad, Math.max(pad, x - w/2));
    var top = Math.min(window.innerHeight - h - pad, Math.max(pad, y - h - 10));
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }
  function hidePop(){ pop.style.display = "none"; }

  popClose.addEventListener("click", hidePop);
  window.addEventListener("keydown", function(e){ if(e.key === "Escape") hidePop(); });
  window.addEventListener("keydown", function(e){
    // Secret teacher toggle
    if(e && (e.ctrlKey || e.metaKey) && e.altKey && (e.key === "T" || e.key === "t")){
      e.preventDefault();
      toggleTeacher();
    }
  });

  if(teacherAnswers) teacherAnswers.addEventListener("click", function(){
    state.teacher.showAnswers = !state.teacher.showAnswers;
    try{ localStorage.setItem("a10_teacher_answers", state.teacher.showAnswers ? "1" : "0"); }catch(e){}
    refreshTeacherUi();
    renderQs();
  });
  if(teacherIds) teacherIds.addEventListener("click", function(){
    state.teacher.showIds = !state.teacher.showIds;
    try{ localStorage.setItem("a10_teacher_ids", state.teacher.showIds ? "1" : "0"); }catch(e){}
    refreshTeacherUi();
    renderQs();
  });
  if(teacherLabels) teacherLabels.addEventListener("click", function(){
    state.teacher.showLabels = !state.teacher.showLabels;
    try{ localStorage.setItem("a10_teacher_labels", state.teacher.showLabels ? "1" : "0"); }catch(e){}
    refreshTeacherUi();
    renderReading();
    renderQs();
  });

  function normItemText(t){
    return (t||"").trim().replace(/\s+/g," ").replace(/[\u2018\u2019]/g,"'").slice(0, 60);
  }

  function addVocabItem(text, kind){
    var t = normItemText(text);
    if(!t) return;
    var toks = t.split(" ").filter(Boolean);
    if(toks.length > 4) t = toks.slice(0,4).join(" ");

    var key = t.toLowerCase();
    for(var i=0;i<state.vocab.length;i++){
      if((state.vocab[i].text||"").toLowerCase() === key) return;
    }
    state.vocab.push({ text: t, kind: kind || "word" });
    state.selectedVocab = { text: t, kind: kind || "word" };
    renderVocab();
  }

  function addWord(w){
    addVocabItem(w, "word");
  }


  function kindLabel(kind){
    if(kind === "phrasal") return "PV";
    if(kind === "collocation") return "COLL";
    return "WORD";
  }

  function renderVocab(){
    wordList.innerHTML = "";
    if(!state.vocab.length){
      var d = document.createElement("div");
      d.className = "tiny";
      d.textContent = "No saved words yet. Select a word/phrase in the text and add it — or press “Suggest for CEFR”.";
      wordList.appendChild(d);
      practiceHint.textContent = "Pick an item from the list, then press “Pronounce”.";
      return;
    }
    state.vocab.forEach(function(item){
      var row = document.createElement("div");
      row.className = "word";

      var left = document.createElement("div");
      var strong = document.createElement("strong");
      strong.textContent = item.text;
      left.appendChild(strong);

      var tag = document.createElement("span");
      tag.className = "pill";
      tag.style.marginLeft = "8px";
      tag.textContent = kindLabel(item.kind);
      left.appendChild(tag);

      var right = document.createElement("div");

      var btn1 = document.createElement("button");
      btn1.className = "linkbtn";
      btn1.textContent = "Select";
      btn1.addEventListener("click", function(){
        state.selectedVocab = item;
        exampleOut.textContent = "";
        practiceHint.textContent = "Selected: " + item.text;
      });

      var btn2 = document.createElement("button");
      btn2.className = "linkbtn";
      btn2.textContent = "✖";
      btn2.title = "Remove";
      btn2.addEventListener("click", function(){
        state.vocab = state.vocab.filter(function(x){ return x.text !== item.text; });
        if(state.selectedVocab && state.selectedVocab.text === item.text) state.selectedVocab = null;
        renderVocab();
      });

      right.appendChild(btn1);
      right.appendChild(btn2);

      row.appendChild(left);
      row.appendChild(right);
      wordList.appendChild(row);
    });
  }


  function findExample(word){
    var text = (data.reading && data.reading[modeEl.value]) ? data.reading[modeEl.value] : "";
    var sentences = text.split(/(?<=[\.\!\?])\s+/);
    var w = (word||"").toLowerCase();
    var hit = sentences.find(function(s){ return (s||"").toLowerCase().indexOf(w) !== -1; });
    return hit ? hit.trim() : "";
  }

  function pronounce(word, slow){
    if(!word) return;
    if(!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    speakText(word, null, slow ? 0.8 : parseFloat(rateEl.value||"1"));
  }

  sayWord.addEventListener("click", function(){ pronounce(state.selectedVocab ? state.selectedVocab.text : null, false); });
  saySlow.addEventListener("click", function(){ pronounce(state.selectedVocab ? state.selectedVocab.text : null, true); });
  exampleBtn.addEventListener("click", function(){
    var ex = findExample(state.selectedVocab ? state.selectedVocab.text : null);
    exampleOut.textContent = ex ? ("Example: " + ex) : "No example found in this mode text.";
  });

  // Game: listen & choose
  function shuffle(a){ for(var i=a.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var t=a[i]; a[i]=a[j]; a[j]=t; } return a; }
  function startListenGame(){
    gameChoices.innerHTML = "";
    if(state.vocab.length < 3){
      gameMsg.textContent = "Add at least 3 words to start the game.";
      return;
    }
    var choices = shuffle(state.vocab.slice()).slice(0,4).map(function(x){ return x.text; });
    var target = choices[Math.floor(Math.random()*choices.length)];
    state.game.target = target;
    state.game.choices = choices;
    gameMsg.textContent = "Listen: which word did you hear?";
    pronounce(target, false);

    choices.forEach(function(w){
      var row = document.createElement("div");
      row.className = "word";
      var left = document.createElement("div");
      left.innerHTML = "<strong>"+escapeHtml(w)+"</strong>";
      var right = document.createElement("div");
      var b = document.createElement("button");
      b.className = "linkbtn";
      b.textContent = "Choose";
      b.addEventListener("click", function(){
        if(w === state.game.target) gameMsg.textContent = "Correct ✅";
        else gameMsg.textContent = "Not yet — repeat and try again.";
      });
      right.appendChild(b);
      row.appendChild(left); row.appendChild(right);
      gameChoices.appendChild(row);
    });
  }
  startGame.addEventListener("click", startListenGame);
  repeatGame.addEventListener("click", function(){ if(state.game.target) pronounce(state.game.target, false); });


  // ---------- CEFR-tuned vocab suggestions (words + collocations + phrasal verbs) ----------
  var STOP = ("a an the and or but if because as until while of at by for with about against between into through during " +
    "before after above below to from up down in out on off over under again further then once here there when where why how " +
    "all any both each few more most other some such no nor not only own same so than too very can will just don should now " +
    "i you he she it we they me him her us them my your his her its our their this that these those is are was were be been " +
    "being have has had do does did doing would could may might must").split(" ");

  function isStop(w){ return STOP.indexOf(w) !== -1; }

  function tokenizeText(text){
    var t = (text||"").toLowerCase();
    return t.match(/[a-zà-öø-ÿ][a-zà-öø-ÿ'\-]*/g) || [];
  }

  function scoreWord(level, w){
    var L = w.length;
    var rare = /[^\x00-\x7F]/.test(w) ? 1 : 0;
    var hy = w.indexOf("-") !== -1 ? 1 : 0;
    var base = L + (rare*1.5) + (hy*1.2);
    if(level === "A1") return -Math.abs(L-5) + (rare*0.5);
    if(level === "A2") return -Math.abs(L-6) + (rare*0.7);
    if(level === "B1") return base;
    if(level === "B2") return base + 0.6;
    return base + 1.2;
  }

  function extractPhrasalVerbs(text){
    var t = (text||"").toLowerCase();
    var re = /\b(look|get|take|make|come|go|put|bring|set|turn|give|find|work|break|carry|pick|run|cut|hold|keep|let|move)\s+(up|down|out|in|on|off|over|back|away|through|around|along)\b/g;
    var out = [];
    var m;
    while((m = re.exec(t)) !== null){
      out.push((m[1] + " " + m[2]).trim());
    }
    var uniq = [];
    out.forEach(function(x){ if(uniq.indexOf(x)===-1) uniq.push(x); });
    return uniq;
  }

  function extractCollocations(tokens){
    var big = {};
    for(var i=0;i<tokens.length-1;i++){
      var a = tokens[i], b = tokens[i+1];
      if(isStop(a) || isStop(b)) continue;
      if(a.length < 4 || b.length < 4) continue;
      var key = a + " " + b;
      big[key] = (big[key]||0) + 1;
    }
    var arr = Object.keys(big).map(function(k){ return { k:k, c:big[k] }; });
    arr.sort(function(x,y){ return y.c - x.c; });
    return arr.map(function(x){ return x.k; });
  }

  function suggestForLevel(level, text){
    var toks = tokenizeText(text);
    var freq = {};
    toks.forEach(function(w){
      if(isStop(w)) return;
      if(w.length < 4) return;
      freq[w] = (freq[w]||0) + 1;
    });
    var words = Object.keys(freq).map(function(w){
      return { w:w, c:freq[w], s: scoreWord(level, w) };
    });
    words.sort(function(a,b){
      var sa = a.s + Math.min(3, a.c);
      var sb = b.s + Math.min(3, b.c);
      return sb - sa;
    });

    var lvl = String(level||"B1");
    var wantWords = (lvl === "A1") ? 6 : (lvl === "A2") ? 7 : (lvl === "B1") ? 8 : 9;
    var wantColl = (lvl === "A1") ? 2 : (lvl === "A2") ? 3 : (lvl === "B1") ? 4 : 5;
    var wantPV = (["A1","A2"].indexOf(lvl) !== -1) ? 1 : 3;

    var pickedWords = [];
    for(var i=0;i<words.length && pickedWords.length<wantWords;i++){
      pickedWords.push(words[i].w);
    }

    return {
      words: pickedWords,
      phrasal: extractPhrasalVerbs(text).slice(0, wantPV),
      collocations: extractCollocations(toks).slice(0, wantColl)
    };
  }

  if(suggestVocab) suggestVocab.addEventListener("click", function(){
    var text = (data.reading && data.reading[modeEl.value]) ? data.reading[modeEl.value] : "";
    var s = suggestForLevel(String(data.level || "B1"), text);
    s.words.forEach(function(w){ addVocabItem(w, "word"); });
    s.phrasal.forEach(function(p){ addVocabItem(p, "phrasal"); });
    s.collocations.forEach(function(c){ addVocabItem(c, "collocation"); });
  });


  // Selection popover actions
  function selectedOrPop(){
    return cleanSelectionText(popWord.textContent || getSelectionText());
  }
  popPronounce.addEventListener("click", function(){ pronounce(selectedOrPop(), false); });
  popAdd.addEventListener("click", function(){ addVocabItem(selectedOrPop(), "word"); hidePop(); });
  popDefine.addEventListener("click", function(){
    var w = selectedOrPop();
    if(!w) return;
    window.open("https://dictionary.cambridge.org/search/english/direct/?q=" + encodeURIComponent(w), "_blank");
  });
  popTranslate.addEventListener("click", function(){
    var w = selectedOrPop();
    if(!w) return;
    window.open("https://translate.google.com/?sl=auto&tl=en&text=" + encodeURIComponent(w) + "&op=translate", "_blank");
  });
  popImages.addEventListener("click", function(){
    var w = selectedOrPop();
    if(!w) return;
    window.open("https://www.google.com/search?tbm=isch&q=" + encodeURIComponent(w), "_blank");
  });

  // Show popover on selection
  function tryOpenPop(evt){
    var t = getSelectionText();
    if(!t || t.length < 2) return;
    showPop(
      evt.clientX || (evt.touches && evt.touches[0] ? evt.touches[0].clientX : 40),
      evt.clientY || (evt.touches && evt.touches[0] ? evt.touches[0].clientY : 40),
      t
    );
  }
  document.addEventListener("mouseup", function(e){ setTimeout(function(){ tryOpenPop(e); }, 0); });
  document.addEventListener("touchend", function(e){ setTimeout(function(){ tryOpenPop(e); }, 0); });

  // Double-click to add word
  readingArea.addEventListener("dblclick", function(){
    var t = getSelectionText();
    if(t) addWord(t);
  });

  // Tabs (UI only — both live together)
  tabVocab.addEventListener("click", function(){ tabVocab.setAttribute("aria-selected","true"); tabListen.setAttribute("aria-selected","false"); });
  tabListen.addEventListener("click", function(){ tabListen.setAttribute("aria-selected","true"); tabVocab.setAttribute("aria-selected","false"); });

  // Mode changes
  modeEl.addEventListener("change", function(){
    renderReading();
    renderQs();
    exampleOut.textContent = "";
  });

  toggleText.addEventListener("click", function(){
    state.hide = !state.hide;
    toggleText.textContent = state.hide ? "👀 Show text" : "🙈 Hide text";
    renderReading();
  });

  // Init voices
  if(window.speechSynthesis){
    listVoices();
    window.speechSynthesis.onvoiceschanged = listVoices;
  } else {
    readAllBtn.disabled = true;
    pauseBtn.disabled = true;
    stopBtn.disabled = true;
  }

  applyChunkUi();
  refreshTeacherUi();
  renderVocab();
  renderReading();
  renderQs();
})();
</script>
</body>
</html>`;
}


/* -------------------- Reading Printables (Student/Key) -------------------- */

function mmToTwip(mm: number) {
  return Math.round((mm / 25.4) * 1440);
}

function splitParasForDoc(text: string): string[] {
  return (text || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function parseMarkdownTable(prompt: string) {
  const lines = (prompt || "").split("\n");
  const tableLines = lines.filter((l) => {
    const s = l.trim();
    return s.startsWith("|") && s.endsWith("|");
  });
  if (tableLines.length < 2) return null;

  const rows = tableLines
    .map((l) => l.trim().slice(1, -1).split("|").map((c) => c.trim()))
    .filter((row) => {
      // remove separator rows like |---|---|
      return !row.every((c) => /^-+$/.test((c || "").replace(/\s+/g, "")));
    });

  if (rows.length < 2) return null;

  const maxCols = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => [...r, ...Array(Math.max(0, maxCols - r.length)).fill("")]);
}

function stripMarkdownTableLines(prompt: string) {
  const lines = (prompt || "").split("\n");
  const keep = lines.filter((l) => {
    const s = l.trim();
    return !(s.startsWith("|") && s.endsWith("|"));
  });
  return keep.map((l) => l.trim()).filter(Boolean);
}

function makeSupportBoxDocx(args: { level: Level }) {
  const baseSize = 24;
  const smallSize = 22;

  const lines: Paragraph[] = [
    new Paragraph({
      spacing: { after: 140, line: 360, lineRule: "auto" },
      children: [new TextRun({ text: "How to answer (quick steps)", bold: true, size: baseSize, font: "Calibri" })],
    }),
    new Paragraph({
      spacing: { after: 80, line: 360, lineRule: "auto" },
      children: [new TextRun({ text: "1) Read the question first.", size: smallSize, font: "Calibri" })],
    }),
    new Paragraph({
      spacing: { after: 80, line: 360, lineRule: "auto" },
      children: [new TextRun({ text: "2) Find key words in the text (names, dates, places).", size: smallSize, font: "Calibri" })],
    }),
    new Paragraph({
      spacing: { after: 80, line: 360, lineRule: "auto" },
      children: [new TextRun({ text: "3) Underline evidence. Then choose your answer.", size: smallSize, font: "Calibri" })],
    }),
    new Paragraph({
      spacing: { after: 120, line: 360, lineRule: "auto" },
      children: [
        new TextRun({
          text: "Same learning target as Standard. Adapted gives extra access supports (spacing/layout), not easier goals.",
          italics: true,
          size: 20,
          font: "Calibri",
        }),
      ],
    }),
  ];

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: lines,
            margins: { top: mmToTwip(2), bottom: mmToTwip(2), left: mmToTwip(2), right: mmToTwip(2) },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 8, color: "666666" },
              bottom: { style: BorderStyle.SINGLE, size: 8, color: "666666" },
              left: { style: BorderStyle.SINGLE, size: 8, color: "666666" },
              right: { style: BorderStyle.SINGLE, size: 8, color: "666666" },
            },
          }),
        ],
      }),
    ],
  });
}

function makeQuestionTable(args: {
  index: number;
  prompt: string;
  options?: string[];
  adapted: boolean;
}) {
  const { index, prompt, options, adapted } = args;
  const baseSize = adapted ? 26 : 22; // 13pt vs 11pt
  const smallSize = adapted ? 22 : 20;

  const promptLines = stripMarkdownTableLines(prompt);
  const table = parseMarkdownTable(prompt);

  const children: Array<Paragraph | Table> = [];

  // Prompt: bold first line, then separate lines for multi-part prompts to reduce visual load.
  if (promptLines.length) {
    children.push(
      new Paragraph({
        spacing: { after: adapted ? 160 : 120, line: adapted ? 360 : 276, lineRule: "auto" },
        children: [
          new TextRun({
            text: `${index}. ${promptLines[0]}`,
            bold: true,
            size: baseSize,
            font: "Calibri",
          }),
        ],
      })
    );

    for (let i = 1; i < promptLines.length; i++) {
      children.push(
        new Paragraph({
          spacing: { after: adapted ? 140 : 100, line: adapted ? 360 : 276, lineRule: "auto" },
          children: [new TextRun({ text: promptLines[i], size: baseSize, font: "Calibri" })],
        })
      );
    }
  } else {
    children.push(
      new Paragraph({
        spacing: { after: adapted ? 160 : 120, line: adapted ? 360 : 276, lineRule: "auto" },
        children: [new TextRun({ text: `${index}.`, bold: true, size: baseSize, font: "Calibri" })],
      })
    );
  }

  // If the prompt contains a markdown table, render it as a real DOCX table.
  if (table) {
    const cols = table[0].length;
    const tRows = table.map((row, rIdx) => {
      return new TableRow({
        children: row.map((cellText) => {
          return new TableCell({
            children: [
              new Paragraph({
                spacing: { after: 80, line: adapted ? 360 : 276, lineRule: "auto" },
                children: [new TextRun({ text: cellText, size: adapted ? 22 : 20, font: "Calibri", bold: rIdx === 0 })],
              }),
            ],
            margins: { top: mmToTwip(1.5), bottom: mmToTwip(1.5), left: mmToTwip(1.2), right: mmToTwip(1.2) },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 6, color: "999999" },
              bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999" },
              left: { style: BorderStyle.SINGLE, size: 6, color: "999999" },
              right: { style: BorderStyle.SINGLE, size: 6, color: "999999" },
            },
          });
        }),
      });
    });

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: tRows,
      })
    );

    // Spacer after table
    children.push(new Paragraph({ text: "" }));
  }

  // Options (MCQ-style)
  if (options && options.length) {
    for (const opt of options) {
      children.push(
        new Paragraph({
          spacing: { after: adapted ? 180 : 120, line: adapted ? 360 : 276, lineRule: "auto" },
          children: [
            new TextRun({
              text: `☐ ${opt}`,
              size: baseSize,
              font: "Calibri",
            }),
          ],
        })
      );
    }

    // Notes/evidence lines (more space for everybody, even Standard)
    children.push(
      new Paragraph({
        spacing: { after: adapted ? 140 : 100, line: adapted ? 360 : 276, lineRule: "auto" },
        children: [
          new TextRun({
            text: "Notes / evidence from the text:",
            bold: true,
            size: smallSize,
            font: "Calibri",
          }),
        ],
      })
    );
    const noteLines = adapted ? 3 : 2;
    for (let i = 0; i < noteLines; i++) {
      children.push(
        new Paragraph({
          spacing: { after: adapted ? 200 : 140, line: adapted ? 360 : 276, lineRule: "auto" },
          children: [
            new TextRun({
              text: "____________________________________________________________",
              size: baseSize,
              font: "Calibri",
            }),
          ],
        })
      );
    }
  } else {
    // Open response: answer lines + notes
    const answerLines = adapted ? 6 : 4;
    for (let i = 0; i < answerLines; i++) {
      children.push(
        new Paragraph({
          spacing: { after: adapted ? 200 : 140, line: adapted ? 360 : 276, lineRule: "auto" },
          children: [
            new TextRun({
              text: "____________________________________________________________",
              size: baseSize,
              font: "Calibri",
            }),
          ],
        })
      );
    }

    children.push(
      new Paragraph({
        spacing: { after: adapted ? 140 : 100, line: adapted ? 360 : 276, lineRule: "auto" },
        children: [
          new TextRun({
            text: "Notes / evidence from the text:",
            bold: true,
            size: smallSize,
            font: "Calibri",
          }),
        ],
      })
    );

    const noteLines = adapted ? 3 : 2;
    for (let i = 0; i < noteLines; i++) {
      children.push(
        new Paragraph({
          spacing: { after: adapted ? 200 : 140, line: adapted ? 360 : 276, lineRule: "auto" },
          children: [
            new TextRun({
              text: "____________________________________________________________",
              size: baseSize,
              font: "Calibri",
            }),
          ],
        })
      );
    }
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: children as any,
            margins: {
              top: mmToTwip(2),
              bottom: mmToTwip(2),
              left: mmToTwip(2),
              right: mmToTwip(2),
            },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 6, color: "999999" },
              bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999" },
              left: { style: BorderStyle.SINGLE, size: 6, color: "999999" },
              right: { style: BorderStyle.SINGLE, size: 6, color: "999999" },
            },
          }),
        ],
      }),
    ],
  });
}

async function buildReadingStudentDocx(args: {
  title: string;
  level: Level;
  mode: "standard" | "adapted";
  readingText: string;
  exercises: ExerciseItem[];
}) {
  const adapted = args.mode === "adapted";
  const baseSize = adapted ? 26 : 22; // 13pt / 11pt
  const headingSize = adapted ? 34 : 30;

  const marginMm = 11; // narrow margins, more writing room

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: mmToTwip(marginMm),
              bottom: mmToTwip(marginMm),
              left: mmToTwip(marginMm),
              right: mmToTwip(marginMm),
            },
          },
        },
        children: [
          new Paragraph({
            spacing: { after: 160 },
            children: [
              new TextRun({
                text: "Aontas 10 — Reading Pack",
                bold: true,
                size: headingSize,
                font: "Calibri",
              }),
            ],
          }),
          new Paragraph({
            spacing: { after: 240 },
            children: [
              new TextRun({
                text: `${args.title} • CEFR ${args.level} • Student Sheet (${adapted ? "B" : "A"})`,
                bold: true,
                size: adapted ? 22 : 20,
                font: "Calibri",
              }),
            ],
          }),

          new Paragraph({
            spacing: { after: 120 },
            children: [new TextRun({ text: "Reading", bold: true, size: adapted ? 30 : 26, font: "Calibri" })],
          }),
          ...splitParasForDoc(args.readingText).map((p) =>
            new Paragraph({
              spacing: { after: adapted ? 240 : 160, line: adapted ? 360 : 276, lineRule: "auto" },
              children: [new TextRun({ text: p, size: baseSize, font: "Calibri" })],
            })
          ),

          new Paragraph({ text: "" }),

          ...(adapted ? [makeSupportBoxDocx({ level: args.level }), new Paragraph({ text: "" })] : []),

          new Paragraph({
            spacing: { after: 120 },
            children: [new TextRun({ text: "Exercises", bold: true, size: adapted ? 30 : 26, font: "Calibri" })],
          }),
          new Paragraph({
            spacing: { after: adapted ? 240 : 160, line: adapted ? 360 : 276, lineRule: "auto" },
            children: [
              new TextRun({
                text: "Multiple-choice: tick one option. Open questions: use the lines. (Same answer key for Standard + Adapted.)",
                size: adapted ? 22 : 20,
                font: "Calibri",
              }),
            ],
          }),

          ...args.exercises.flatMap((q, idx) => {
            const side = q[args.mode];
            const prompt = side?.prompt || "";
            const options = side?.options || [];
            return [
              new Paragraph({ text: "" }),
              makeQuestionTable({
                index: idx + 1,
                prompt,
                options: options.length ? options : undefined,
                adapted,
              }),
            ];
          }),
        ],
      },
    ],
  });

  return Packer.toBlob(doc);
}

async function buildReadingTeacherKeyDocx(args: {
  title: string;
  level: Level;
  standardText: string;
  adaptedText: string;
  exercises: ExerciseItem[];
}) {
  const marginMm = 12;

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: mmToTwip(marginMm),
              bottom: mmToTwip(marginMm),
              left: mmToTwip(marginMm),
              right: mmToTwip(marginMm),
            },
          },
        },
        children: [
          new Paragraph({
            spacing: { after: 140 },
            children: [new TextRun({ text: "Aontas 10 — Reading Pack", bold: true, size: 30, font: "Calibri" })],
          }),
          new Paragraph({
            spacing: { after: 200 },
            children: [new TextRun({ text: `${args.title} • CEFR ${args.level} • Teacher Key`, bold: true, size: 22, font: "Calibri" })],
          }),

          new Paragraph({ text: "" }),

          new Paragraph({
            spacing: { after: 120 },
            children: [new TextRun({ text: "Answer Key (shared Standard + Adapted)", bold: true, size: 26, font: "Calibri" })],
          }),
          new Paragraph({
            spacing: { after: 160, line: 276, lineRule: "auto" },
            children: [
              new TextRun({
                text: "Adapted supports access (layout, spacing, cues) without changing targets or the answer key.",
                italics: true,
                size: 20,
                font: "Calibri",
              }),
            ],
          }),

          ...args.exercises.flatMap((q, idx) => {
            const qHead = (q.standard?.prompt || "").split("\n")[0].trim();
            const ans = q.answer;
            const ansText = Array.isArray(ans) ? ans.join("; ") : String(ans);
            return [
              new Paragraph({
                spacing: { after: 60, line: 276, lineRule: "auto" },
                children: [new TextRun({ text: `${idx + 1}. ${qHead}`, bold: true, size: 22, font: "Calibri" })],
              }),
              new Paragraph({
                spacing: { after: 180, line: 276, lineRule: "auto" },
                children: [new TextRun({ text: `Answer: ${ansText}`, size: 22, font: "Calibri" })],
              }),
            ];
          }),

          new Paragraph({ text: "" }),
          new Paragraph({
            spacing: { after: 120 },
            children: [new TextRun({ text: "Texts (reference)", bold: true, size: 24, font: "Calibri" })],
          }),

          new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: "STANDARD", bold: true, size: 20, font: "Calibri" })] }),
          ...splitParasForDoc(args.standardText).map((p) =>
            new Paragraph({
              spacing: { after: 120, line: 276, lineRule: "auto" },
              children: [new TextRun({ text: p, size: 22, font: "Calibri" })],
            })
          ),

          new Paragraph({ text: "" }),
          new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: "ADAPTED", bold: true, size: 20, font: "Calibri" })] }),
          ...splitParasForDoc(args.adaptedText).map((p) =>
            new Paragraph({
              spacing: { after: 120, line: 276, lineRule: "auto" },
              children: [new TextRun({ text: p, size: 22, font: "Calibri" })],
            })
          ),
        ],
      },
    ],
  });

  return Packer.toBlob(doc);
}

function buildReadingStudentPdf(args: {
  title: string;
  level: Level;
  mode: "standard" | "adapted";
  readingText: string;
  exercises: ExerciseItem[];
}): Blob {
  const adapted = args.mode === "adapted";
  const doc = new jsPDF({ unit: "mm", format: "a4" });

  const margin = 11; // narrower margins = more writing room
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const maxW = pageW - margin * 2;

  let y = margin;

  const h1 = adapted ? 17 : 15;
  const h2 = adapted ? 14 : 12;
  const body = adapted ? 12.5 : 10.5;
  const line = adapted ? 6.0 : 4.8;

  const addPageIfNeeded = (extra = 12) => {
    if (y + extra > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  doc.setFontSize(h1);
  doc.text("Aontas 10 — Reading Pack", margin, y);
  y += adapted ? 8 : 7;

  doc.setFontSize(body);
  doc.text(`${args.title} • CEFR ${args.level} • Student Sheet (${adapted ? "B" : "A"})`, margin, y);
  y += adapted ? 7 : 6;

  doc.setFontSize(h2);
  doc.text("Reading", margin, y);
  y += adapted ? 7 : 6;

  doc.setFontSize(body);
  for (const p of splitParasForDoc(args.readingText)) {
    addPageIfNeeded(16);
    y = pdfAddWrapped(doc, p, margin, y, maxW, line);
    y += adapted ? 5 : 3.5;
  }

  addPageIfNeeded(18);
  doc.setFontSize(h2);
  doc.text("Exercises", margin, y);
  y += adapted ? 7 : 6;

  doc.setFontSize(adapted ? 11 : 9.5);
  y = pdfAddWrapped(
    doc,
    "Tick one option for MCQs. Use the lines to write your answers and notes.",
    margin,
    y,
    maxW,
    adapted ? 5.2 : 4.4
  );
  y += adapted ? 4 : 3;

  args.exercises.forEach((q, idx) => {
    const side = q[args.mode];
    const prompt = (side?.prompt || "").trim();
    const opts = side?.options || [];

    addPageIfNeeded(28);

    const promptLines = doc.splitTextToSize(`${idx + 1}. ${prompt}`, maxW - 4) as string[];
    const boxH = promptLines.length * (adapted ? 6.2 : 5.0) + 6;

    doc.setDrawColor(170);
    doc.rect(margin, y, maxW, boxH);
    doc.setFontSize(adapted ? 12.5 : 10.5);
    doc.text(promptLines, margin + 2, y + (adapted ? 6 : 5));
    y += boxH + (adapted ? 4 : 3);

    doc.setFontSize(adapted ? 12 : 10);
    if (opts.length) {
      opts.forEach((o) => {
        addPageIfNeeded(10);
        y = pdfAddWrapped(doc, `☐ ${o}`, margin + 2, y, maxW - 2, line);
        y += 1;
      });
      y += 2;
      doc.setFontSize(adapted ? 11.5 : 9.5);
      y = pdfAddWrapped(doc, "Notes / evidence from the text:", margin + 2, y, maxW - 2, adapted ? 5.2 : 4.4);
      y += 1;
      doc.setFontSize(adapted ? 12 : 10);
      const noteLines = adapted ? 3 : 2;
      for (let i2 = 0; i2 < noteLines; i2++) {
        addPageIfNeeded(8);
        doc.text("______________________________________________", margin + 2, y);
        y += adapted ? 7 : 6;
      }
    } else {
      const answerLines = adapted ? 6 : 4;
      for (let i2 = 0; i2 < answerLines; i2++) {
        addPageIfNeeded(8);
        doc.text("______________________________________________", margin + 2, y);
        y += adapted ? 7 : 6;
      }
      y += 1;
      doc.setFontSize(adapted ? 11.5 : 9.5);
      y = pdfAddWrapped(doc, "Notes / evidence from the text:", margin + 2, y, maxW - 2, adapted ? 5.2 : 4.4);
      y += 1;
      doc.setFontSize(adapted ? 12 : 10);
      const noteLines = adapted ? 3 : 2;
      for (let i3 = 0; i3 < noteLines; i3++) {
        addPageIfNeeded(8);
        doc.text("______________________________________________", margin + 2, y);
        y += adapted ? 7 : 6;
      }
    }

    y += adapted ? 7 : 5;
  });

  return doc.output("blob");
}

function buildReadingTeacherKeyPdf(args: {
  title: string;
  level: Level;
  standardText: string;
  adaptedText: string;
  exercises: ExerciseItem[];
}): Blob {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const margin = 12;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const maxW = pageW - margin * 2;
  let y = margin;

  const addPageIfNeeded = (extra = 12) => {
    if (y + extra > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  doc.setFontSize(16);
  doc.text("Teacher Key — Reading Pack", margin, y);
  y += 7;

  doc.setFontSize(11);
  doc.text(`${args.title} • CEFR ${args.level}`, margin, y);
  y += 6;

  doc.setFontSize(10);
  y = pdfAddWrapped(
    doc,
    "Answer key is shared across Standard and Adapted. Adapted supports access (layout, spacing, cues) without changing targets.",
    margin,
    y,
    maxW,
    4.6
  );
  y += 4;

  doc.setFontSize(12);
  doc.text("Answer Key", margin, y);
  y += 6;

  doc.setFontSize(10);
  args.exercises.forEach((q, idx) => {
    addPageIfNeeded(14);
    const head = (q.standard?.prompt || "").split("\n")[0].trim();
    y = pdfAddWrapped(doc, `${idx + 1}. ${head}`, margin, y, maxW, 4.6);
    const ans = q.answer;
    const ansText = Array.isArray(ans) ? ans.join("; ") : String(ans);
    y = pdfAddWrapped(doc, `Answer: ${ansText}`, margin + 2, y, maxW - 2, 4.6);
    y += 3;
  });

  addPageIfNeeded(20);
  doc.setDrawColor(180);
  doc.line(margin, y, pageW - margin, y);
  y += 6;

  doc.setFontSize(12);
  doc.text("Texts (reference)", margin, y);
  y += 6;

  doc.setFontSize(10);
  doc.text("STANDARD", margin, y);
  y += 5;
  for (const p of splitParasForDoc(args.standardText)) {
    addPageIfNeeded(14);
    y = pdfAddWrapped(doc, p, margin, y, maxW, 4.6);
    y += 3;
  }

  addPageIfNeeded(16);
  doc.setFontSize(10);
  doc.text("ADAPTED", margin, y);
  y += 5;
  for (const p of splitParasForDoc(args.adaptedText)) {
    addPageIfNeeded(14);
    y = pdfAddWrapped(doc, p, margin, y, maxW, 4.6);
    y += 3;
  }

  return doc.output("blob");
}

/* --------------------------------- Page ---------------------------------- */


export default function Page() {
  // Source
  const [articleUrl, setArticleUrl] = useState("");
  const [articleTitle, setArticleTitle] = useState<string>("");
  const [inputText, setInputText] = useState("");

  // Settings
  const [outputLanguage, setOutputLanguage] = useState<(typeof OUTPUT_LANGUAGES)[number]>(
    "English"
  );
  const [level, setLevel] = useState<Level>("B1");
  const [dyslexiaFriendly, setDyslexiaFriendly] = useState(true);

  const [textType, setTextType] = useState<(typeof TEXT_TYPES)[number]>("Article");

  const [questionFocus, setQuestionFocus] = useState<QuestionFocus>("balanced");
  const [selectedBlocks, setSelectedBlocks] = useState<ExerciseBlockId[]>(() =>
    defaultBlocksFor("B1", "balanced")
  );

  // Reading outputs
  const [standardReading, setStandardReading] = useState("");
  const [adaptedReading, setAdaptedReading] = useState("");
  const [exercises, setExercises] = useState<ExerciseItem[]>([]);
  const [readingStatus, setReadingStatus] = useState<string>("");

  // Listening Focus inputs + outputs
  const [listeningTitle, setListeningTitle] = useState("");
  const [listeningScript, setListeningScript] = useState("");
  const [audioMode, setAudioMode] = useState<"tts" | "url">("tts");
  const [audioUrl, setAudioUrl] = useState("");
  const [listeningPack, setListeningPack] = useState<ListeningPack | null>(null);
  const [listeningStatus, setListeningStatus] = useState<string>("");

  const effectiveTitle = useMemo(() => {
    return listeningTitle.trim() || articleTitle.trim() || "Listening Focus";
  }, [listeningTitle, articleTitle]);

  async function fetchArticle(e: FormEvent) {
    e.preventDefault();
    setReadingStatus("Fetching article…");
    try {
      const res = await fetch("/api/fetch-article", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: articleUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch article");
      setArticleTitle(data?.title || "");
      setInputText(data?.text || "");
      setReadingStatus("Article loaded.");
    } catch (err: any) {
      setReadingStatus(err?.message || "Failed to fetch article.");
    }
  }

  async function generateReading() {
    setReadingStatus("Generating Standard/Adapted reading…");
    try {
      const res = await fetch("/api/adapt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputText,
          outputLanguage,
          level,
          textType,
          outputType: textType,
          questionFocus,
          blocks: selectedBlocks,
          selectedBlocks,
          dyslexiaFriendly,
        }),
      });
      const data: AdaptResponse = await res.json();
      if (!res.ok) throw new Error(data?.error || "Adaptation failed");
      setStandardReading(data.standardOutput || "");
      setAdaptedReading(data.adaptedOutput || "");
      setReadingStatus(data.warning ? `Done (note: ${data.warning})` : "Done.");
    } catch (err: any) {
      setReadingStatus(err?.message || "Adaptation failed.");
    }
  }


  function applyExercisePreset(forLevel: Level = level, focus: QuestionFocus = questionFocus) {
    setSelectedBlocks(defaultBlocksFor(forLevel, focus));
  }

  function toggleBlock(id: ExerciseBlockId) {
    setSelectedBlocks((prev) => {
      const has = prev.includes(id);
      if (has) return prev.filter((x) => x !== id);
      return [...prev, id];
    });
  }

  async function generateExercises() {
    if (!selectedBlocks.length) {
      setReadingStatus("Select at least one exercise block first.");
      return;
    }

    if (!standardReading.trim() || !adaptedReading.trim()) {
      setReadingStatus("Generate the Standard + Adapted reading first (both are required for a shared answer key)." );
      return;
    }

    setReadingStatus("Generating exercises…");
    try {
      const res = await fetch("/api/exercises", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputText,
          standardOutput: standardReading,
          adaptedOutput: adaptedReading,
          // Backward/forward compatible naming
          standardText: standardReading,
          adaptedText: adaptedReading,
          standard: standardReading,
          adapted: adaptedReading,
          outputLanguage,
          level,
          textType,
          outputType: textType,
          questionFocus,
          blocks: selectedBlocks,
          selectedBlocks,
        }),
      });
      const data: ExercisesResponse = await res.json();
      if (!res.ok) throw new Error(data?.error || "Exercise generation failed");
      setExercises(data.items || []);
      setReadingStatus("Exercises generated.");
    } catch (err: any) {
      setReadingStatus(err?.message || "Exercise generation failed.");
    }
  }

  async function exportReadingInteractiveHtml() {
    const title = articleTitle || "Reading Pack";
    const html = buildReadingInteractiveHtml({
      title,
      level,
      standardText: standardReading || inputText,
      adaptedText: adaptedReading || inputText,
      exercises,
    });
    downloadBlob(
      new Blob([html], { type: "text/html;charset=utf-8" }),
      `aontas10-reading-${slugify(title)}-${level}-deluxe.html`
    );
  }

  async function exportReadingStudentDocxPair() {
    const title = articleTitle || "Reading Pack";
    const base = `aontas10-reading-${slugify(title)}-${level}`;
    const stdBlob = await buildReadingStudentDocx({
      title,
      level,
      mode: "standard",
      readingText: standardReading || inputText,
      exercises,
    });
    const adpBlob = await buildReadingStudentDocx({
      title,
      level,
      mode: "adapted",
      readingText: adaptedReading || inputText,
      exercises,
    });
    downloadBlob(stdBlob, `${base}-student-A.docx`);
    downloadBlob(adpBlob, `${base}-student-B.docx`);
  }

  async function exportReadingTeacherKeyDocx() {
    const title = articleTitle || "Reading Pack";
    const base = `aontas10-reading-${slugify(title)}-${level}`;
    const keyBlob = await buildReadingTeacherKeyDocx({
      title,
      level,
      standardText: standardReading || inputText,
      adaptedText: adaptedReading || inputText,
      exercises,
    });
    downloadBlob(keyBlob, `${base}-teacher-key.docx`);
  }

  function exportReadingStudentPdfs() {
    const title = articleTitle || "Reading Pack";
    const base = `aontas10-reading-${slugify(title)}-${level}`;
    const std = buildReadingStudentPdf({
      title,
      level,
      mode: "standard",
      readingText: standardReading || inputText,
      exercises,
    });
    const adp = buildReadingStudentPdf({
      title,
      level,
      mode: "adapted",
      readingText: adaptedReading || inputText,
      exercises,
    });
    downloadBlob(std, `${base}-student-A.pdf`);
    downloadBlob(adp, `${base}-student-B.pdf`);
  }

  function exportReadingTeacherKeyPdf() {
    const title = articleTitle || "Reading Pack";
    const base = `aontas10-reading-${slugify(title)}-${level}`;
    const key = buildReadingTeacherKeyPdf({
      title,
      level,
      standardText: standardReading || inputText,
      adaptedText: adaptedReading || inputText,
      exercises,
    });
    downloadBlob(key, `${base}-teacher-key.pdf`);
  }

  async function generateListeningPack() {
    setListeningStatus("Generating Listening Focus pack…");
    try {
      // Preferred: LLM-backed route (you can add it later).
      const res = await fetch("/api/listening-pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: effectiveTitle,
          level,
          textType,
          outputType: textType,
          questionFocus,
          blocks: selectedBlocks,
          selectedBlocks,
          script: listeningScript || adaptedReading || inputText,
          audioMode,
          audioUrl: audioMode === "url" ? audioUrl : undefined,
        }),
      });

      if (res.ok) {
        const pack = (await res.json()) as ListeningPack;
        setListeningPack(pack);
        setListeningStatus("Listening pack generated (API).");
        return;
      }

      // Fallback to local generator if route doesn't exist yet
      const script = (listeningScript || adaptedReading || inputText).trim();
      if (!script) throw new Error("No listening script text available.");

      const pack = buildLocalListeningPack({
        title: effectiveTitle,
        level,
        textType,
        script,
        audioMode,
        audioUrl: audioMode === "url" ? audioUrl : undefined,
        questionFocus,
        selectedBlocks,
      });
      setListeningPack(pack);
      setListeningStatus("Listening pack generated (local fallback).");
    } catch (err: any) {
      setListeningStatus(err?.message || "Listening pack generation failed.");
    }
  }

  function exportListeningInteractiveHtml() {
    if (!listeningPack) return;
    const html = buildListeningFocusHtml(listeningPack);
    downloadBlob(
      new Blob([html], { type: "text/html;charset=utf-8" }),
      `aontas10-listening-${slugify(listeningPack.meta.title)}-${listeningPack.meta.level}.html`
    );
  }

  function exportListeningStudentPdfs() {
    if (!listeningPack) return;
    const base = `aontas10-listening-${slugify(listeningPack.meta.title)}-${listeningPack.meta.level}`;
    const std = buildListeningStudentPdf(listeningPack, "standard");
    const adp = buildListeningStudentPdf(listeningPack, "adapted");
    downloadBlob(std, `${base}-student-A.pdf`);
    downloadBlob(adp, `${base}-student-B.pdf`);
  }

  function exportListeningTeacherKeyPdf() {
    if (!listeningPack) return;
    const base = `aontas10-listening-${slugify(listeningPack.meta.title)}-${listeningPack.meta.level}`;
    const key = buildListeningTeacherKeyPdf(listeningPack);
    downloadBlob(key, `${base}-teacher-key.pdf`);
  }

  function exportListeningPackJson() {
    if (!listeningPack) return;
    downloadBlob(
      new Blob([JSON.stringify(listeningPack, null, 2)], {
        type: "application/json;charset=utf-8",
      }),
      `aontas10-listening-${slugify(listeningPack.meta.title)}-${listeningPack.meta.level}.json`
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-black tracking-tight">Aontas 10 Generator</h1>
          <p className="text-slate-300 text-sm">
            Reading Pack + Listening Focus Pack (separate interactive export + printables).
          </p>
        </header>

        {/* Source */}
        <section className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 md:grid-cols-4">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-slate-300">CEFR level</span>
                <select
                  value={level}
                  onChange={(e) => setLevel(e.target.value as Level)}
                  className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2"
                >
                  {levels.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs text-slate-300">Output language</span>
                <select
                  value={outputLanguage}
                  onChange={(e) =>
                    setOutputLanguage(e.target.value as (typeof OUTPUT_LANGUAGES)[number])
                  }
                  className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2"
                >
                  {OUTPUT_LANGUAGES.map((lang) => (
                    <option key={lang} value={lang}>
                      {lang}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs text-slate-300">Text type</span>
                <select
                  value={textType}
                  onChange={(e) =>
                    setTextType(e.target.value as (typeof TEXT_TYPES)[number])
                  }
                  className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2"
                >
                  {TEXT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>


              <label className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-900 px-3 py-2">
                <input
                  type="checkbox"
                  checked={dyslexiaFriendly}
                  onChange={(e) => setDyslexiaFriendly(e.target.checked)}
                />
                <span className="text-sm text-slate-200">Dyslexia-friendly</span>
              </label>
            </div>

            <form onSubmit={fetchArticle} className="flex flex-col gap-2">
              <label className="text-xs text-slate-300">Article URL (optional)</label>
              <div className="flex gap-2">
                <input
                  value={articleUrl}
                  onChange={(e) => setArticleUrl(e.target.value)}
                  placeholder="https://…"
                  className="w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2"
                />
                <button
                  type="submit"
                  className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 font-semibold hover:bg-white/15"
                >
                  Fetch
                </button>
              </div>
              {!!articleTitle && (
                <div className="text-sm text-slate-300">Loaded: {articleTitle}</div>
              )}
            </form>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-300">Input text</span>
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                rows={8}
                className="rounded-2xl border border-white/10 bg-slate-900 px-3 py-2"
                placeholder="Paste your article text here…"
              />
            </label>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={generateReading}
                className="rounded-xl bg-sky-500/20 px-4 py-2 font-semibold text-sky-200 hover:bg-sky-500/25"
              >
                Generate reading (Standard + Adapted)
              </button>

              <button
                disabled={!selectedBlocks.length || !standardReading.trim() || !adaptedReading.trim()}
                title={
                  !selectedBlocks.length
                    ? "Select at least one exercise block"
                    : !standardReading.trim() || !adaptedReading.trim()
                      ? "Generate the Standard + Adapted reading first"
                      : ""
                }
                onClick={generateExercises}
                className="rounded-xl bg-emerald-500/20 px-4 py-2 font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Generate exercises
              </button>

              <div className="ml-auto text-sm text-slate-300">{readingStatus}</div>
            </div>

            <div className="mt-4 rounded-2xl border border-white/10 bg-slate-900 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-extrabold">Exercise blocks</div>
                  <div className="text-xs text-slate-400 mt-1">
                    Choose which blocks of questions to generate. Each item has a STANDARD and an ADAPTED version, but they all share a single answer key so the whole class can work together.
                  </div>
                </div>

                <button
                  onClick={() => applyExercisePreset(level, questionFocus)}
                  className="rounded-xl bg-violet-500/20 px-4 py-2 font-semibold text-violet-200 hover:bg-violet-500/25"
                  type="button"
                >
                  Apply for level {level}
                </button>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div>
                  <div className="text-xs font-bold text-slate-300">Question focus</div>
                  <select
                    value={questionFocus}
                    onChange={(e) => setQuestionFocus(e.target.value as QuestionFocus)}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2"
                  >
                    {QUESTION_FOCUS_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <div className="mt-2 text-xs text-slate-400">
                    {QUESTION_FOCUS_OPTIONS.find((o) => o.id === questionFocus)?.hint}
                  </div>

                  <div className="mt-3 text-xs text-slate-400">
                    Selected blocks:{" "}
                    {selectedBlocks.length
                      ? selectedBlocks
                          .map((id) => EXERCISE_BLOCKS.find((b) => b.id === id)?.short || id)
                          .join(", ")
                      : "None"}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedBlocks(defaultBlocksFor(level, questionFocus))}
                      className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/15"
                    >
                      Reset to recommended
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedBlocks(EXERCISE_BLOCKS.map((b) => b.id))}
                      className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/15"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedBlocks([])}
                      className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/15"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div>
                  <div className="text-xs font-bold text-slate-300">Blocks</div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {EXERCISE_BLOCKS.map((b) => {
                      const checked = selectedBlocks.includes(b.id);
                      return (
                        <label
                          key={b.id}
                          className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2 text-sm hover:bg-slate-950/60"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleBlock(b.id)}
                          />
                          <span>{b.label}</span>
                        </label>
                      );
                    })}
                  </div>

                  <div className="mt-3 text-xs text-slate-400">
                    Tip: In Listening Focus, the supports change. Here, the blocks change what question types you generate.
                  </div>
                </div>
              </div>
            </div>

          </div>
        </section>

        {/* Reading Pack */}
        <section className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-black">Reading Pack</h2>
                <p className="text-sm text-slate-300">
                  Deluxe interactive HTML + separate printables (Student Std/Adpt + Teacher Key).
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={exportReadingInteractiveHtml}
                  className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 font-semibold hover:bg-white/15"
                >
                  Download interactive HTML (deluxe)
                </button>
                <button
                  onClick={exportReadingStudentPdfs}
                  className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 font-semibold hover:bg-white/15"
                >
                  Student PDFs (Sheets A+B)
                </button>
                <button
                  onClick={exportReadingTeacherKeyPdf}
                  className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 font-semibold hover:bg-white/15"
                >
                  Teacher key PDF
                </button>
                <button
                  onClick={exportReadingStudentDocxPair}
                  className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 font-semibold hover:bg-white/15"
                >
                  Student DOCX (Sheets A+B)
                </button>
                <button
                  onClick={exportReadingTeacherKeyDocx}
                  className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 font-semibold hover:bg-white/15"
                >
                  Teacher key DOCX
                </button>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-slate-900 p-3">
                <div className="text-xs font-bold text-slate-300">STANDARD</div>
                <pre className="mt-2 whitespace-pre-wrap text-sm text-slate-100">
                  {standardReading || "—"}
                </pre>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-900 p-3">
                <div className="text-xs font-bold text-slate-300">ADAPTED</div>
                <pre className="mt-2 whitespace-pre-wrap text-sm text-slate-100">
                  {adaptedReading || "—"}
                </pre>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-slate-900 p-3">
              <div className="text-xs font-bold text-slate-300">Exercises preview</div>
              <div className="mt-2 space-y-2 text-sm text-slate-100">
                {exercises.length ? (
                  exercises.slice(0, 6).map((q) => (
                    <div key={q.id} className="rounded-xl border border-white/10 bg-white/5 p-2">
                      <div className="font-semibold">{q.standard.prompt}</div>
                      <div className="text-slate-300 text-xs">
                        Type: {q.type} • Skill: {q.skill}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-slate-400">No exercises yet.</div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Listening Focus Pack */}
        <section className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-black">Listening Focus Pack</h2>
                <p className="text-sm text-slate-300">
                  Separate interactive HTML export + printable Standard/Adapted sheets + teacher key.
                </p>
              </div>
              <div className="text-sm text-slate-300">{listeningStatus}</div>
            </div>

            <div className="grid gap-3 md:grid-cols-4">
              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-xs text-slate-300">Listening title</span>
                <input
                  value={listeningTitle}
                  onChange={(e) => setListeningTitle(e.target.value)}
                  placeholder={articleTitle || "Listening Focus"}
                  className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs text-slate-300">Audio mode</span>
                <select
                  value={audioMode}
                  onChange={(e) => setAudioMode(e.target.value as "tts" | "url")}
                  className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2"
                >
                  <option value="tts">TTS (offline-friendly)</option>
                  <option value="url">Audio URL</option>
                </select>
              </label>

              {audioMode === "url" && (
                <label className="flex flex-col gap-1 md:col-span-3">
                  <span className="text-xs text-slate-300">Audio URL</span>
                  <input
                    value={audioUrl}
                    onChange={(e) => setAudioUrl(e.target.value)}
                    placeholder="https://…/audio.mp3"
                    className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2"
                  />
                </label>
              )}
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-300">
                Listening script (used to chunk + build activities)
              </span>
              <textarea
                value={listeningScript}
                onChange={(e) => setListeningScript(e.target.value)}
                rows={7}
                className="rounded-2xl border border-white/10 bg-slate-900 px-3 py-2"
                placeholder="Paste a listening script here. Tip: use the Adapted reading as a starting point."
              />
            </label>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setListeningScript(adaptedReading || inputText)}
                className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 font-semibold hover:bg-white/15"
              >
                Use Adapted reading as script
              </button>

              <button
                onClick={generateListeningPack}
                className="rounded-xl bg-violet-500/20 px-4 py-2 font-semibold text-violet-200 hover:bg-violet-500/25"
              >
                Generate Listening Pack
              </button>

              <button
                disabled={!listeningPack}
                onClick={exportListeningInteractiveHtml}
                className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 font-semibold hover:bg-white/15 disabled:opacity-40"
              >
                Download interactive HTML
              </button>

              <button
                disabled={!listeningPack}
                onClick={exportListeningStudentPdfs}
                className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 font-semibold hover:bg-white/15 disabled:opacity-40"
              >
                Student PDFs (Sheets A+B)
              </button>

              <button
                disabled={!listeningPack}
                onClick={exportListeningTeacherKeyPdf}
                className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 font-semibold hover:bg-white/15 disabled:opacity-40"
              >
                Teacher key PDF
              </button>

              <button
                disabled={!listeningPack}
                onClick={exportListeningPackJson}
                className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 font-semibold hover:bg-white/15 disabled:opacity-40"
              >
                Download pack JSON
              </button>
            </div>

            <div className="rounded-2xl border border-white/10 bg-slate-900 p-3">
              <div className="text-xs font-bold text-slate-300">Listening pack preview</div>
              {listeningPack ? (
                <div className="mt-2 grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                    <div className="text-sm font-semibold">Chunks</div>
                    <div className="mt-2 space-y-2 text-sm text-slate-200">
                      {listeningPack.chunks.slice(0, 6).map((c) => (
                        <div
                          key={c.id}
                          className="rounded-xl border border-white/10 bg-slate-950/40 p-2"
                        >
                          <div className="font-semibold">{c.label}</div>
                          <div className="text-xs text-slate-400">
                            Anchors: {c.anchors.join(", ") || "—"}
                          </div>
                        </div>
                      ))}
                      {listeningPack.chunks.length > 6 && (
                        <div className="text-xs text-slate-400">
                          + {listeningPack.chunks.length - 6} more…
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                    <div className="text-sm font-semibold">Activities</div>
                    <div className="mt-2 space-y-2 text-sm text-slate-200">
                      {listeningPack.activities.slice(0, 6).map((a, i) => (
                        <div
                          key={a.id}
                          className="rounded-xl border border-white/10 bg-slate-950/40 p-2"
                        >
                          <div className="font-semibold">
                            {i + 1}. {a.type}
                          </div>
                          <div className="text-xs text-slate-400">{a.standard.prompt}</div>
                        </div>
                      ))}
                      {listeningPack.activities.length > 6 && (
                        <div className="text-xs text-slate-400">
                          + {listeningPack.activities.length - 6} more…
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-2 text-sm text-slate-400">No pack yet.</div>
              )}
            </div>

            <div className="text-xs text-slate-400">
              Note: If you host the interactive HTML on an LMS/HTTPS later, you can add optional mic
              features. This version stays fully useful on <code>file://</code>.
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
