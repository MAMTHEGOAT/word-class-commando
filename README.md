# Word Class Commando

A single-file browser app for KS3 and IGCSE English: word classes, literary techniques,
punctuation, verb tenses and the vocabulary of analytical writing. Written for a British
curriculum classroom with many EAL pupils. No accounts and no AI. Practice stays in the
browser; only a Challenge score a pupil chooses to submit goes to the leaderboard.

**Live app:** https://mamthegoat.github.io/word-class-commando/

Sister app to **[Analysis Acrobat](https://mamthegoat.github.io/analysis-acrobat/)**, which
teaches Cambridge 0500 language analysis. This one sits a level below it: you cannot find a
*powerful verb* until you can find a verb.

## What is in it

Six domains, 32 activities, each with a Learn page:

| Domain | What pupils do |
|---|---|
| Word classes | Find, name and use nouns, verbs, adjectives and adverbs (eight activities) |
| Techniques (SOAPMAPS) | Know, find and take apart the SOAPMAPS techniques, plus alliteration and hyperbole |
| Techniques (Expanded) | The harder techniques: find them, animal or human, semantic field, and the terms for writing about them |
| Punctuation | Spot the mistake, find it then fix it, proofread a paragraph, put the commas in, comma or full stop |
| Verb tenses | Spot the wrong tense in a sentence or a paragraph, and put the right tense in |
| Analytical language | Words to use instead of "the writer shows": their meanings, their jobs, and which one is true of an extract |

**Practise** has no timer and no score. Most activities have four levels (Easiest to Hardest).

**Challenge** is timed, with a leaderboard for each skill: Word classes (one minute),
Punctuation, Verb tenses and Techniques (two minutes each), and Ultimate Champion (four
minutes, every discipline in turn). A wrong answer costs three points and breaks the chain.
Nicknames only appear on the board once a teacher has approved them.

Three things it tries to do differently:

- **It never tells you a true thing is false.** Tap a word that really is an adverb in a
  round asking for a different kind, and it says so without marking you down.
- **The feedback teaches the check, not the answer.** Every wrong tap comes back with the
  test you should have applied.
- **Nothing about the shape of a question answers it.** The banks are measured so that
  position, length or a word ending cannot stand in for knowing the grammar.

## Running it

Open `index.html` in any browser. That is the whole thing. The leaderboard only works from
the live site.

## For developers

`index.html?validate` runs the content validator; it must show **0 ERRORS**. The leaderboard
service is in `worker/` (see its README).

Built by an English teacher with Claude. All content is original.
