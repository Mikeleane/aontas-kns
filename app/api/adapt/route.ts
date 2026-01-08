import { NextResponse } from "next/server";

type AdaptRequestBody = {
  inputText: string;
  outputLanguage: string;
  level: string; // CEFR: A1, A2, B1, B2, C1, C2
  outputType: string; // article, report, email, etc.
  dyslexiaFriendly?: boolean;
};

type ModelResult = {
  standard: string;
  adapted: string;
};

type LengthTargets = {
  standardMin: number;
  standardMax: number;
  adaptedMin: number;
  adaptedMax: number;
};

/**
 * Hard-ish word-length targets per CEFR level for reading texts.
 * These are used to tell the model exactly what ranges to aim for.
 */
function getLengthTargets(level: string): LengthTargets {
  switch (level.toUpperCase()) {
    case "A1":
      return {
        standardMin: 80,
        standardMax: 150,
        adaptedMin: 60,
        adaptedMax: 120,
      };
    case "A2":
      return {
        standardMin: 150,
        standardMax: 300,
        adaptedMin: 120,
        adaptedMax: 250,
      };
    case "B1":
      return {
        standardMin: 350,
        standardMax: 550,
        adaptedMin: 280,
        adaptedMax: 450,
      };
    case "B2":
      return {
        standardMin: 500,
        standardMax: 900,
        adaptedMin: 400,
        adaptedMax: 750,
      };
    case "C1":
    case "C2":
      return {
        standardMin: 800,
        standardMax: 1300,
        adaptedMin: 650,
        adaptedMax: 1100,
      };
    default:
      // Fallback if someone passes something weird – treat as B1-ish.
      return {
        standardMin: 350,
        standardMax: 550,
        adaptedMin: 280,
        adaptedMax: 450,
      };
  }
}

function simpleFallbackAdaptation(
  inputText: string,
  outputLanguage: string,
  level: string,
  outputType: string,
  dyslexiaFriendly: boolean | undefined,
  reason: string
) {
  const standardOutput = [
    `STANDARD VERSION (fallback – reason: ${reason})`,
    `Language: ${outputLanguage}`,
    `CEFR level: ${level}`,
    `Output type: ${outputType}`,
    "",
    inputText.trim(),
  ].join("\n");

  const adaptedHeader = dyslexiaFriendly
    ? `ADAPTED VERSION (fallback – reason: ${reason}, reduced cognitive load, extra spacing)`
    : `ADAPTED VERSION (fallback – reason: ${reason}, reduced cognitive load)`;

  const adaptedOutput = [
    adaptedHeader,
    `Language: ${outputLanguage}`,
    `CEFR level: ${level}`,
    `Output type: ${outputType}`,
    "",
    inputText
      .trim()
      .split(/(?<=[.!?])\s+/)
      .join("\n\n"),
  ].join("\n");

  return { standardOutput, adaptedOutput };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as AdaptRequestBody;
    const { inputText, outputLanguage, level, outputType, dyslexiaFriendly } =
      body;

    if (!inputText || !outputLanguage || !level || !outputType) {
      return NextResponse.json(
        { error: "Missing required fields." },
        { status: 400 }
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const modelName = process.env.OPENAI_MODEL || "gpt-4.1-mini";

    console.log("Aontas-10 API key present?", !!apiKey);
    console.log("Aontas-10 model:", modelName);

    const inputWordCount = inputText.trim().length
      ? inputText.trim().split(/\s+/).length
      : 0;

    const targets = getLengthTargets(level);

    if (!apiKey) {
      console.warn("OPENAI_API_KEY missing – using fallback adaptation.");
      const { standardOutput, adaptedOutput } = simpleFallbackAdaptation(
        inputText,
        outputLanguage,
        level,
        outputType,
        dyslexiaFriendly,
        "NO_API_KEY_CONFIGURED"
      );
      return NextResponse.json({ standardOutput, adaptedOutput });
    }

    const systemPrompt = `
You are Aontas-10, an assistant that adapts classroom reading texts for inclusive ESL/ELT classrooms across CEFR levels.

You must ALWAYS produce TWO versions of the same content:

1) STANDARD VERSION
- Same CEFR level as requested.
- Same output type/genre (article, report, blog post, informal email, formal email, social media chat, etc.).
- Clean, coherent, natural text for that CEFR level.
- Keep all key ideas, domain concepts, and important details that a learner at that level should encounter.
- You may tidy structure and wording, but you MUST keep the overall level and genre.

2) ADAPTED VERSION
- Same CEFR level AND same genre as the STANDARD VERSION (do NOT drop the level).
- Same core ideas, key facts, and technical vocabulary needed for the learning goal.
- Do NOT change facts or add new ones.
- Reduce cognitive load by:
  - Using short, clear sentences (typically 10–20 words; shorter at lower levels).
  - Keeping one main idea per sentence.
  - Adding a 1–2 sentence overview at the very top that explains what the whole text is about in simple terms.
  - Organising the text with short paragraphs and meaningful headings (e.g. "Background", "How it works", "Why it matters") where appropriate.
  - Using bullet points or numbered lists for steps, lists, and procedures.
  - Making causal and logical relationships explicit (for example: "Because X happened, Y changed." "As a result, ...").
- Remove non-essential clutter:
  - Strip out navigation labels, wire credits, "+1", stray site labels, and other web/metadata noise.
- Keep important technical words BUT:
  - Briefly explain difficult terms the first time they appear (for example: "conservator (a person who repairs and protects old art)").
- The ADAPTED version should be CLEARLY shorter than the STANDARD version, but still within the CEFR-appropriate range.

DYSLEXIA-FRIENDLY INTENT
- When dyslexia support is requested:
  - Write the ADAPTED version in a way that works well with dyslexia-friendly formatting:
    - Short paragraphs and clear headings.
    - No huge unbroken blocks of text.
    - Logical order and clear signposting with connectors (first, then, next, as a result, however, in contrast, etc.).

CEFR LEVEL RULES (APPROXIMATE TARGETS FOR READING TEXTS)

These rules describe the target text the model should create. They do NOT describe the learner's abilities.

A1:
- STANDARD target length: about 80–150 words (ABSOLUTE MAXIMUM 150 words).
- ADAPTED target length: about 60–120 words.
- Text types: very short personal messages, notes, simple descriptions, very short emails, very simple dialogues or chat exchanges.
- Structure:
  - 1–3 very short paragraphs or sections.
  - Almost all simple sentences with one idea each.
  - Very limited subordination; mostly "and", "but", "then".
- Register and vocabulary:
  - High-frequency everyday words only.
  - Very concrete; avoid abstract nouns and complex nominalisations.
  - Neutral or informal tone.

A2:
- STANDARD target length: about 150–300 words (ABSOLUTE MAXIMUM 350 words).
- ADAPTED target length: about 120–250 words.
- Text types: short articles, blog posts, simple reports, informal emails with some detail, simple narratives and news items about familiar topics.
- Structure:
  - 2–4 paragraphs.
  - Mostly simple sentences, but some simple compound/complex sentences (e.g. "They tested the robot because the site has many broken frescoes.").
  - Basic connectors: because, when, then, after that.
- Register and vocabulary:
  - Everyday vocabulary, plus some topic-specific words with support.
  - Mostly concrete language; some simple abstract words are allowed.
  - Neutral tone; can be mildly formal for simple articles/reports.

B1:
- STANDARD target length: about 350–550 words (ABSOLUTE MAXIMUM 600 words).
- ADAPTED target length: about 280–450 words.
- If the source text is much longer than this, you MUST CONDENSE it:
  - Keep the most important rules, processes, events, and examples.
  - Remove repetition, minor details, and long lists of edge cases.
  - Focus on what a B1 learner really needs to understand the topic.
- Text types: news-style articles, short reports, blog posts, opinion pieces, longer informal emails, simple formal emails, biographies, explanations of processes.
- Structure:
  - 3–6 paragraphs.
  - Mix of simple, compound, and manageable complex sentences.
  - Clear discourse markers: first, then, however, in contrast, as a result, therefore.
  - A basic pattern is fine: introduction → development → conclusion.
- Register and vocabulary:
  - General vocabulary plus topic-specific terms (with light support if needed).
  - Some abstract nouns (project, purpose, solution, culture, preservation).
  - Neutral or moderately formal register is acceptable for articles/reports.

B2:
- STANDARD target length: about 500–900 words.
- ADAPTED target length: about 400–750 words.
- Structure:
  - 4–8 paragraphs (introduction, background, development sections, conclusion).
  - Frequent complex sentences with relative clauses, conditionals, and concessive clauses.
  - Richer discourse markers: nevertheless, on the other hand, in addition, consequently, in contrast, in summary.
- Register and vocabulary:
  - More abstract vocabulary and domain-specific terms are allowed and expected.
  - Formal or semi-formal register is natural.
- Key vocabulary behaviour (STANDARD and ADAPTED):
  - Keep important domain-specific terms (for example technical art, science, or legal terms) in BOTH the STANDARD and ADAPTED versions.
  - In the ADAPTED version, briefly explain these terms the first time they appear instead of removing them.


C1/C2:
- STANDARD target length: about 800–1300 words.
- ADAPTED target length: about 650–1100 words.
- Text types: academic-style articles, critical essays, extended reports, complex opinion pieces, policy analysis.
- Structure:
  - 6–10 paragraphs, possibly with sections like abstract, background, discussion, limitations, implications.
  - Complex, varied sentence patterns are common.
- Register and vocabulary:
  - Fully comfortable with abstract, technical, and figurative language.
  - Typically formal / academic register.
- Key vocabulary behaviour (STANDARD and ADAPTED):
  - Keep key technical and domain-specific terms in BOTH versions.
  - In the ADAPTED version, support the reader by giving a short explanation when these terms appear, but do not replace them with simpler words.


ADAPTED VS STANDARD BEHAVIOUR BY LEVEL

- At A1–A2:
  - STANDARD: follow the level rules above.
  - ADAPTED: same level and genre but with even shorter sentences and clearer paragraphs; you may slightly shorten the text, but do not drop key ideas.
- At B1:
  - STANDARD: follow the B1 rules above, including the 350–550 word target (NEVER exceed 600 words).
  - ADAPTED:
    - Keep topic-specific vocabulary and key details.
    - Reduce unnecessary complexity, repetition, and minor legal/technical detail.
    - Use headings and bullet points; make causal links and structure explicit.
    - Ensure the ADAPTED version stays within the B1 target range (about 280–450 words), even if the original text is much longer.
- At B2 and C1/C2:
  - STANDARD: full use of the level's complexity and register within the word-range targets.
  - ADAPTED:
    - Do NOT significantly simplify the vocabulary or drop the CEFR level.
    - Focus on clarifying structure, argument, and paragraphing.
    - Split only the most difficult, overloaded sentences.
    - Keep the formal / academic tone, but make the organisation and logic easier to follow.
    - Keep key domain-specific terms in BOTH versions so that vocabulary exercises can target the same words for all students.


GENERAL CONSTRAINTS

- Always write in the requested OUTPUT LANGUAGE.
- Always respect the requested CEFR LEVEL and OUTPUT TYPE/GENRE.
- You may condense, summarise, and merge minor details as needed to meet the word-length targets, but NEVER remove or change core facts, events, rules, or arguments.
- If you cannot hit the target range exactly without deleting crucial information, you may slightly exceed the maximum by up to about 10%, but you must stay as close as possible.
- Do NOT mention these instructions or CEFR rules in your output.
- Do NOT add tasks, questions, or commentary; only the adapted texts.
`;

    const userPrompt = `
INPUT TEXT (to adapt):

"""${inputText}"""

Approximate original text length: about ${inputWordCount} words.

Requested output language: ${outputLanguage}
Requested CEFR level: ${level}
Requested output type/genre: ${outputType}
Dyslexia-friendly support requested: ${dyslexiaFriendly ? "yes" : "no"}

For this CEFR level, the approximate word-length targets are:
- STANDARD VERSION: between ${targets.standardMin} and ${targets.standardMax} words.
- ADAPTED VERSION: between ${targets.adaptedMin} and ${targets.adaptedMax} words.
If the original text is much longer than these ranges, you MUST condense and summarise less important details while keeping the core content.
If the original text is shorter than these ranges, do NOT pad with irrelevant information.

TASK:
1. Write the STANDARD VERSION of the text that respects the CEFR rules, genre, level, and length targets.
2. Write the ADAPTED VERSION of the text that respects:
   - The same CEFR level and genre.
   - The adaptation and cognitive-load rules given in the system instructions.
   - The requirement to be clearly shorter than the STANDARD text and within its own length range.

RESPONSE FORMAT (IMPORTANT):
Respond ONLY with valid JSON, with this exact structure and no extra text:

{
  "standard": "STANDARD VERSION HERE",
  "adapted": "ADAPTED VERSION HERE"
}
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        temperature: 0.4,
        max_tokens: 2048,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenAI API error:", response.status, errorText);
      const { standardOutput, adaptedOutput } = simpleFallbackAdaptation(
        inputText,
        outputLanguage,
        level,
        outputType,
        dyslexiaFriendly,
        "API_ERROR"
      );
      return NextResponse.json(
        {
          standardOutput,
          adaptedOutput,
          warning:
            "AI API request failed – returned fallback adaptation instead.",
        },
        { status: 200 }
      );
    }

    const data: any = await response.json();
    const content: string =
      data?.choices?.[0]?.message?.content?.trim() ?? "";

    let parsed: ModelResult | null = null;

    try {
      parsed = JSON.parse(content) as ModelResult;
    } catch (parseError) {
      console.error("Error parsing model JSON:", parseError, content);
    }

    if (!parsed?.standard || !parsed?.adapted) {
      const { standardOutput, adaptedOutput } = simpleFallbackAdaptation(
        inputText,
        outputLanguage,
        level,
        outputType,
        dyslexiaFriendly,
        "PARSE_ERROR"
      );
      return NextResponse.json(
        {
          standardOutput,
          adaptedOutput,
          warning:
            "Could not parse AI response JSON – returned fallback adaptation instead.",
        },
        { status: 200 }
      );
    }

    const standardOutput = parsed.standard;
    const adaptedOutput = parsed.adapted;

    return NextResponse.json({
      standardOutput,
      adaptedOutput,
    });
  } catch (error) {
    console.error("Error in /api/adapt:", error);
    return NextResponse.json(
      { error: "Something went wrong processing the request." },
      { status: 500 }
    );
  }
}
