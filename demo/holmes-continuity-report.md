# Doyle vs Doyle: a Holmes continuity report

What happens when you feed all sixty Sherlock Holmes stories to a
continuity linter, in the order Doyle published them, and ask it to
complain every time a new story contradicts the ones that came before?

This is that experiment. Public-domain text from
[Project Gutenberg](https://www.gutenberg.org/); short excerpts only.
Built with [canonlint](https://github.com/AlphaBetSoup789/canonlint).

## How this was produced

1. Ingest each story into a local canon database in publication order.
2. Before ingesting story *n*, run `canonlint check` against stories 1…*n−1*.
3. Keep every contradiction that can cite a real canon excerpt
   (precision over recall — uncertain calls stay out of this list).

This checked-in report was regenerated with the deterministic Holmes mock
provider (`npm run demo:holmes`) — **$0 model spend**. A live Anthropic
ingest of the same ~650k-word corpus is the single-digit-to-low-double-digit
dollar estimate from the README; swap `CANONLINT_PROVIDER=anthropic` when
you want the model, not the agent, to extract claims.

## Scoreboard

| | |
| --- | ---: |
| Stories ingested | 60 |
| Checks run | 59 |
| Contradictions with citations | 2 |
| Timeline issues | 0 |
| New facts (not listed below) | 790 |
| Uncertain (routed away from Contradictions) | 223 |

## The hits

### Watson's wandering war wound

Dr. Watson cannot seem to agree whether his Afghan bullet struck his leg or his shoulder. Doyle was famously casual about Watson's biography — canonlint catches each fresh placement.

#### Draft contradicts canon on wound_location.

- **canon** A Study in Scarlet, CHAPTER I. (part 1/4) — "There I was struck on the shoulder by a Jezail bullet"
- **draft** The Sign of the Four, Chapter I (part 2/4) — "sat nursing my wounded leg. I had a Jezail bullet through
it"
- Draft says "leg" but canon says "shoulder".

### Mary Morstan / Mary Watson

Mary appears in *The Sign of the Four*, marries Watson, then quietly vanishes from the record while Watson's domestic situation keeps shifting. Timeline and marital-status claims are a fertile hunting ground.

#### Draft contradicts canon on marital_status.

- **canon** The Adventure of the Empty House, empty-house.txt (part 5/10) — "own sad bereavement"
- **draft** The Adventure of the Dying Detective, dying-detective.txt (part 1/7) — "second year of my married life and told me of the sad condition to
which my poor frie"
- Draft says "married, second year of married life" but canon says "widowed".

## Appendix: per-story check counts

| # | Story | Contradictions |
| ---: | --- | ---: |
| 2 | The Sign of the Four | 1 |
| 3 | A Scandal in Bohemia | 0 |
| 4 | The Red-Headed League | 0 |
| 5 | A Case of Identity | 0 |
| 6 | The Boscombe Valley Mystery | 0 |
| 7 | The Five Orange Pips | 0 |
| 8 | The Man with the Twisted Lip | 0 |
| 9 | The Adventure of the Blue Carbuncle | 0 |
| 10 | The Adventure of the Speckled Band | 0 |
| 11 | The Adventure of the Engineer's Thumb | 0 |
| 12 | The Adventure of the Noble Bachelor | 0 |
| 13 | The Adventure of the Beryl Coronet | 0 |
| 14 | The Adventure of the Copper Beeches | 0 |
| 15 | The Adventure of Silver Blaze | 0 |
| 16 | The Adventure of the Cardboard Box | 0 |
| 17 | The Adventure of the Yellow Face | 0 |
| 18 | The Adventure of the Stockbroker's Clerk | 0 |
| 19 | The Adventure of the Gloria Scott | 0 |
| 20 | The Adventure of the Musgrave Ritual | 0 |
| 21 | The Adventure of the Reigate Squire | 0 |
| 22 | The Adventure of the Crooked Man | 0 |
| 23 | The Adventure of the Resident Patient | 0 |
| 24 | The Adventure of the Greek Interpreter | 0 |
| 25 | The Adventure of the Naval Treaty | 0 |
| 26 | The Adventure of the Final Problem | 0 |
| 27 | The Hound of the Baskervilles | 0 |
| 28 | The Adventure of the Empty House | 0 |
| 29 | The Adventure of the Norwood Builder | 0 |
| 30 | The Adventure of the Dancing Men | 0 |
| 31 | The Adventure of the Solitary Cyclist | 0 |
| 32 | The Adventure of the Priory School | 0 |
| 33 | The Adventure of Black Peter | 0 |
| 34 | The Adventure of Charles Augustus Milverton | 0 |
| 35 | The Adventure of the Six Napoleons | 0 |
| 36 | The Adventure of the Three Students | 0 |
| 37 | The Adventure of the Golden Pince-Nez | 0 |
| 38 | The Adventure of the Missing Three-Quarter | 0 |
| 39 | The Adventure of the Abbey Grange | 0 |
| 40 | The Adventure of the Second Stain | 0 |
| 41 | The Adventure of Wisteria Lodge | 0 |
| 42 | The Adventure of the Bruce-Partington Plans | 0 |
| 43 | The Adventure of the Devil's Foot | 0 |
| 44 | The Adventure of the Red Circle | 0 |
| 45 | The Disappearance of Lady Frances Carfax | 0 |
| 46 | The Adventure of the Dying Detective | 1 |
| 47 | The Valley of Fear | 0 |
| 48 | His Last Bow | 0 |
| 49 | The Adventure of the Mazarin Stone | 0 |
| 50 | The Problem of Thor Bridge | 0 |
| 51 | The Adventure of the Creeping Man | 0 |
| 52 | The Adventure of the Sussex Vampire | 0 |
| 53 | The Adventure of the Three Garridebs | 0 |
| 54 | The Adventure of the Illustrious Client | 0 |
| 55 | The Adventure of the Three Gables | 0 |
| 56 | The Adventure of the Blanched Soldier | 0 |
| 57 | The Adventure of the Lion's Mane | 0 |
| 58 | The Adventure of the Retired Colourman | 0 |
| 59 | The Adventure of the Veiled Lodger | 0 |
| 60 | The Adventure of Shoscombe Old Place | 0 |

---

_Corpus: Arthur Conan Doyle, public domain in the US. Last US-copyrighted_
_Holmes stories entered the public domain in 2023. Sources via Project Gutenberg._
