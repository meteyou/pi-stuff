---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one.

If a question can be answered by exploring the codebase, explore the codebase instead.

## Question format

Format every question using this structure – separate each question with `---`:

```
Optional intro text (brief, one paragraph max)

---

Headline of question 1

Description with context, examples, options etc.
Can span multiple lines and paragraphs.

---

Headline of question 2

More description here.

---
```

Rules:
- Each question block is wrapped between `---` lines (markdown horizontal rules)
- The first non-empty line after `---` is the headline (short, descriptive title)
- Everything after the headline is the description (context, examples, options, the actual question)
- Never use `---` inside a description – it is reserved as question separator
- Always end with a trailing `---` after the last question
- Intro text before the first `---` is optional and brief

When the interview is complete, summarize all key decisions in a structured format (problem, solution, constraints, open questions resolved). Then ask if the user wants to create a PRD from the results (skill:write-a-prd).
