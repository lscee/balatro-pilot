# Balatro operational rulebook

This is trusted baseline game knowledge. Read all of it before choosing any action. The current screenshot and the exact visible text of a Joker, Blind, deck, stake, card, voucher, tag, pack, or consumable override generic strategy because modifiers deliberately change these rules.

## Objective and round flow

- A run normally advances through Small Blind, Big Blind, and Boss Blind rounds across Antes. Beat a Blind by reaching its target score before running out of Hands. Running out of Hands below target loses the run.
- Small and Big Blinds may offer a Skip Tag instead of a fight. Skipping loses their normal money, shop, scaling opportunities, and other round benefits; take a tag only when its visible value exceeds those costs. Boss Blinds cannot normally be skipped and impose a rule shown on screen.
- After winning, collect/cash out, use the shop, and advance. Remaining Hands normally pay money. Interest normally rewards retained money in $5 bands up to the current cap; visible deck, voucher, stake, challenge, or Blind effects may change this.
- Hands, Discards, hand size, Joker slots, consumable slots, prices, rewards, and target scaling are resources, not constants. Read the visible counters and modifiers every round.

## Stake rules in the installed 1.0.1o build

- Stakes are cumulative. Gold applies every rule below it; it is not a single isolated modifier.
- White is the baseline. Red removes the Small Blind's fixed $3 reward (remaining-Hand money, interest, and other income still work). Green raises the Blind scaling curve. Black allows Eternal Jokers. Blue removes one starting Discard. Purple raises the Blind scaling curve again. Orange allows Perishable Jokers. Gold allows Rental Jokers.
- On Purple, Orange, and Gold, the Small Blind base targets by Ante 1 through 8 are 300, 1,000, 3,200, 9,000, 25,000, 60,000, 110,000, and 200,000. Big Blind is normally 1.5x; most Bosses are 2x, with visible exceptions. A deck such as Plasma can multiply this again. Prefer the exact runtime Blind target over memorized arithmetic.
- Eternal means the Joker normally cannot be sold or destroyed and permanently consumes its slot. This makes a weak Eternal purchase much more expensive than its sticker price.
- Perishable starts with 5 Blinds of life, loses one counter after each completed Blind, and becomes permanently debuffed when the counter reaches 0. It does not disappear and still occupies a slot; sell a non-Eternal expired or soon-expiring piece when its remaining contribution no longer justifies the slot.
- Rental normally costs $1 to buy but charges exactly $3 after every completed Blind, even while debuffed. Multiple Rentals add. A Perishable+Rental continues charging after expiry until sold. Eternal+Rental is normally an irreversible $3-per-Blind liability and must be rejected unless it is the only clearly proven immediate survival line.
- Price recurring Sticker liabilities over the expected holding horizon, not at the displayed purchase price. Before any buy, pack, or reroll, reserve the next two Rental payments and show the resulting cash/debt explicitly. Do not describe a Rental as cheap merely because it costs $1.

## Selecting, playing, and discarding cards

- A normal Play Hand or Discard selection contains **1 through 5 cards**. Five is the maximum, not a requirement. The Psychic Boss Blind is a notable rule that requires exactly 5 played cards; obey the visible Boss text.
- Play Hand spends one Hand. It classifies the selected cards, scores the cards that belong to that poker hand, resolves card/Joker effects, then draws replacements when available.
- Discard spends one Discard, scores nothing, removes the selected cards for this round, and draws the same number when available. Use it to improve draw odds while preserving cards important to the target hand or held-card effects.
- Extra selected cards that do not belong to the classified hand are normally **unscored**. Pair may include up to 3 unscored cards, Three of a Kind up to 2, Two Pair or Four of a Kind up to 1, and High Card scores only its highest relevant card. Do not assume kickers add their rank Chips.
- Add extra cards to a short poker hand for a deliberate reason: Splash makes every played card score; Stone Cards score independently; a visible effect explicitly triggers; a Boss requires 5 cards; or cycling dead cards improves the next draw. With future Hands and cards left in the draw pile, spare Play Hand slots are often best used to remove the lowest-value unrelated cards without spending a Discard. Keep useful outs and held effects instead. These cycle fillers remain unscored unless an effect says otherwise.
- A raised card is selected. Determine the entire desired selection before clicking. Never click an already raised card that should remain selected. Commit with Play Hand or Discard only after 1–5 desired cards are visibly selected.
- The visible hand may contain fewer cards than its nominal capacity only when the draw pile is exhausted. While cards remain in the draw pile, an `N/C` hand counter with `N < C` means the deal/draw animation is incomplete and must not be acted on.

## Poker hands and base level-1 score

- High Card: no higher hand; only the highest relevant card scores. Base 5 Chips x 1 Mult.
- Pair: 2 cards of one rank. Base 10 x 2.
- Two Pair: 2 different pairs. Base 20 x 2.
- Three of a Kind: 3 cards of one rank. Base 30 x 3.
- Straight: 5 consecutive ranks. Base 30 x 4. Ace can be high or low, not wrap around, unless a visible modifier changes the rule.
- Flush: 5 cards treated as one suit. Base 35 x 4.
- Full House: a Three of a Kind plus a Pair. Base 40 x 4.
- Four of a Kind: 4 cards of one rank. Base 60 x 7.
- Straight Flush/Royal Flush: a Straight all in one suit; Royal is 10-J-Q-K-A. Base 100 x 8.
- Secret hands become possible after deck modification: Five of a Kind is 5 of one rank (120 x 12); Flush House is a suited Full House (140 x 14); Flush Five is 5 cards of the same rank and suit (160 x 16).
- Planet cards level their named hand and permanently raise its base Chips and Mult for the current run. A lower nominal hand may outperform a rarer hand after levels and Joker synergy, so estimate the current build rather than following hand rank alone.

## Scoring and trigger order

- Conceptually, score is Chips multiplied by Mult after all applicable effects. Start with the played hand's current level, add Chips from scoring cards and chip effects, add +Mult effects, and apply XMult multiplicatively when they trigger.
- Standard rank Chips are Ace 11, face cards 10, and numbered cards their number. Only scoring cards contribute rank Chips unless an effect such as Splash changes scoring eligibility.
- Trigger wording is exact: "when scored", "when played", "held in hand", "at end of round", hand type, rank, suit, edition, enhancement, seal, retrigger, first/last hand, and remaining resources are different conditions.
- Played cards resolve in their effective order and Jokers resolve left to right. Put additive Mult before XMult when movable and when no interaction requires another order. Retriggers repeat eligible card/Joker effects, not arbitrary unrelated effects.
- Debuffed cards/Jokers provide no normal Chips or effect while debuffed. Read Boss rules before choosing the scoring cards and do not rely on a debuffed centerpiece.

## Playing-card modifiers

- Enhancements replace one another. Bonus adds Chips; Mult adds +Mult; Wild counts as any suit but can be debuffed by suit rules; Glass gives XMult when scored and may break; Steel gives XMult while held; Stone has no rank/suit and gives Chips when scored; Gold gives money when held at round end; Lucky has visible random money/Mult chances.
- Editions are separate from enhancements: Foil adds Chips, Holographic adds Mult, Polychrome adds XMult, and Negative grants an extra slot for the relevant card type.
- Seals are separate again: Red retriggers, Gold pays when its card scores, Blue can create the Planet for the final hand while held at round end, and Purple can create a Tarot when discarded. Respect consumable capacity.
- Card rank, suit, enhancement, edition, seal, debuff state, and any permanent bonus can all matter simultaneously. Never infer an unreadable modifier.

## Jokers, consumables, packs, and order

- Joker text is authoritative and conditional. Evaluate the whole owned lineup as a build: flat Chips, +Mult, scaling, XMult, economy, hand-shaping, retriggers, and destructive or probabilistic effects. A Joker slot has opportunity cost.
- Joker editions and stickers matter. Apply the exact Stake rules above rather than treating stickers as generic prose; other visible modifiers must be honored literally.
- Tarot cards modify cards or economy; Planet cards level poker hands; Spectral cards give strong deck/Joker changes with stated costs; playing cards add to the deck. Use consumables only when their target requirements and resulting slots are clear.
- In a pack, inspect all visible choices, the number of picks, and Skip. Choose the option with the best build/economy value, then stop for a fresh screenshot after the layout changes.

## Shop and economy

- In shops, compare purchase benefit, sale value, reroll cost, current cash, interest threshold, future Blind survival, and free slots. Do not buy an item merely because it is affordable.
- Treat the runtime `stickerEconomy` and `stakeRules` values as binding. Include Rental upkeep, remaining Perishable life, Eternal locked-slot cost, and negative cash in every shop comparison. A clean Joker, Rental copy, Perishable copy, and Eternal copy are different offers with different expected values.
- Buy & Use is legal only when that exact control is visibly present. A full consumable area does not create the control. In particular, a targeted Tarot such as The Hierophant cannot be bought into full slots when the shop shows only Buy; do not click an imagined Buy & Use location. Skip it, legally use/sell an owned consumable through a visible control, or advance the round.
- Treat idle cash as an opportunity cost, not an objective. When scoring is weak or the next Blind is not reliably covered, prioritize affordable Jokers and other durable upgrades over preserving an interest band. An empty Joker slot alone is not a reason to buy: if survival is already reliable, skip a weak non-scaling placeholder and preserve cash, interest, and slot flexibility for a stronger offer. Buy useful early bridges only when their survival/economy value exceeds that opportunity cost, then replace weak pieces as the build becomes clearer.
- Inspect every visible offer before leaving. If one or more purchases materially improve scoring, scaling, economy, deck quality, or survival, spend proactively in best-value order; leave money unspent only when the available upgrades are genuinely weak, harmful, unaffordable, or saving it has greater expected run value.
- Vouchers apply run-long rules and can be high leverage. Booster packs trade money for a constrained choice. Rerolls become more expensive unless modified.
- Preserve interest when survival is already likely; spend aggressively when the next Blind cannot be beaten or when a purchase creates decisive scaling. In the mid game, accumulated money should enable a deliberate pivot when a powerful offered Joker has present support, enough setup time, an affordable path, and a replaceable slot. Do not pivot from a functioning invested engine to a lone speculative combo piece. Selling a core Joker can collapse the build, while selling a weak bridge or redundancy can fund a stronger route.

## Decision standard

- Before every hand, enumerate every visible rank/suit and currently selected card, identify all legal 1–5 card hands and upgrade routes, account for active effects and Boss rules, and compare immediate score, draw quality, Hands/Discards remaining, retained-card value, and known remaining-deck outs.
- Compute the remaining target deficit and the average progress required per remaining Hand. Maximize the probability of clearing the Blind over the entire remaining resource horizon, not the current hand's isolated score or nominal category.
- Preserve made-hand cores when a discard can cheaply improve them: for example, retain both pairs from AA+JJ and discard unrelated cards toward a Full House or Four of a Kind when sufficient outs/resources remain. Do not spend the final Hand while usable Discards can materially improve an otherwise losing hand.
- After choosing to Play Hand, distinguish its scoring core from spare cycle slots. If later Hands remain, include low-value unrelated cards in those slots when replacing them improves the next draw and does not sacrifice an out or held effect.
- Prefer a line that can beat the current target reliably. Avoid consuming scarce Discards when the current hand already wins; avoid wasting Hands on low scores unless it deliberately scales the build or fixes draw state.
- If an exact effect, counter, card, button, or selection state required for the decision is unreadable, wait/request detail rather than inventing it.
