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

**Practice.** Four activities, across four difficulty levels:

- **Click the word** and **Click all the words** — find the class in a real sentence.
- **Where does it fit?** — one word, three gaps, which one takes it? This covers all four
  classes already, so adjectives and adverbs are taught here first.
- **Yes or no** — one word marked in its sentence, one question, a streak to beat.

Nouns and verbs are scored in the click rounds; adjectives and adverbs are coming.

Three things it tries to do differently:

- **It never tells you a true thing is false.** Click a word that really is an adverb in a
  round asking for a different kind, and it says so and moves on, without marking you down.
- **A verb can be more than one word.** *Was reading*, *did not bark*, *has never eaten*,
  *picked the box up*. On the easier levels the app marks the whole verb for you. On the
  harder ones you have to find every part yourself, because spotting the helper word is the
  skill.
- **The feedback teaches the check, not the answer.** Every wrong click comes back with the
  test you should have applied, not just a cross.

## Running it

Open `index.html` in any browser. That is the whole thing.

## For developers

`index.html?validate` runs the content validator and prints a report. It must show
**0 ERRORS** after any change to the word banks. It also prints the lemma map, the pool
sizes per activity and level, and any word carrying two classes.

Built by an English teacher with Claude. All content is original.
