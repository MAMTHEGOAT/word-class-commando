# Word Class Commando

A single-file browser app for practising English word classes: nouns, verbs, adjectives and
adverbs. Students find the words in a sentence and name the job each one is doing.
Deterministic and offline: no accounts, no backend, no AI, and nothing leaves the browser.

**Live app:** https://mamthegoat.github.io/word-class-commando/

Sister app to **[Analysis Acrobat](https://mamthegoat.github.io/analysis-acrobat/)**, which
teaches Cambridge 0500 language analysis. This one sits a level below it: you cannot find a
*powerful verb* until you can find a verb.

## What is in it

**Learn.** One card per class: what it is in plain English, a check you can actually apply
inside a sentence, a worked example, and an honest list of the exceptions.

**Practice.** *Click the word* and *Click all the words*, across four difficulty levels.
Nouns and verbs are live; adjectives and adverbs are coming.

Three things it tries to do differently:

- **It never tells you a true thing is false.** Click a word that really is an adverb in a
  round asking for a different kind, and it says so and moves on, without marking you down.
- **A verb can be more than one word.** *Was reading*, *did not bark*, *has never eaten*,
  *picked the box up*. On the easier levels the app marks the whole verb for you. On the
  harder ones you have to find every part yourself, because spotting the helper word is the
  skill.
- **The feedback teaches the check, not the answer.**

## Running it

Open `index.html` in any browser. That is the whole thing.

## For developers

`index.html?validate` runs the content validator and prints a report. It must show
**0 ERRORS** after any change to the word banks.

Built by an English teacher with Claude. All content is original.
