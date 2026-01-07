# Fiducia Crowdfunding Smart Contract

This Clarity contract implements a simple crowdfunding flow: creators open campaigns with a goal and deadline; donors contribute STX; if the goal is met and the deadline has passed, the creator can claim the funds. The contract also tracks successful claims and awards a badge after two.

All amounts are in microSTX. Deadlines use `stacks-block-height`.

## Storage

- campaign-counter (uint)
  - Auto-incrementing counter; also implies the next campaign id.
- campaigns (map uint → {creator, goal, raised, deadline, claimed})
  - creator: principal
  - goal: uint (microSTX)
  - raised: uint (microSTX)
  - deadline: uint (block height)
  - claimed: bool
- donations (map {id: uint, funder: principal} → {amount: uint})
  - Stores the last recorded donation amount per funder per campaign id.
- claim-count (map principal → uint)
  - Number of successful claims by a principal.
- badges (map principal → bool)
  - Presence indicates the user has earned a badge.

## Constants

- MIN-GOAL = u1_000_000 (1 STX)
- MAX-GOAL = u1_000_000_000_000 (1,000,000 STX)
- MIN-DONATION = u100_000 (0.1 STX)
- MAX-CAMPAIGN-DURATION = u52_560 (~1 year at 10 min blocks)

## Errors

- ERR-INVALID-DEADLINE u400
- ERR-CAMPAIGN-EXPIRED u401
- ERR-INVALID-AMOUNT u402
- ERR-UNAUTHORIZED u403
- ERR-NOT-FOUND u404
- ERR-TOO-EARLY u405
- ERR-GOAL-NOT-MET u406
- ERR-ALREADY-CLAIMED u407
- ERR-TRANSFER-FAILED u408 (defined; not used directly)
- ERR-INVALID-GOAL u409
- ERR-DEADLINE-TOO-FAR u410

## Public entrypoints

- (create-campaign (goal uint) (deadline uint)) → (response uint uint)
  - Validates goal within [MIN-GOAL, MAX-GOAL].
  - Validates deadline: must be in the future and within MAX-CAMPAIGN-DURATION blocks from now.
  - Creates campaign with raised = u0, claimed = false, id = current campaign-counter; increments counter.
  - Returns ok id.

- (donate (id uint) (amount uint)) → (response uint uint)
  - Validates id < campaign-counter.
  - Validates amount ≥ MIN-DONATION.
  - Requires current block < campaign.deadline.
  - Transfers amount from tx-sender to the contract.
  - Increments campaign.raised by amount.
  - Records donations[{id, funder}] = {amount} (overwrites previous per funder/id).
  - Returns ok amount.

- (claim-funds (id uint)) → (response bool uint)
  - Validates id < campaign-counter.
  - Requires tx-sender == campaign.creator.
  - Requires now ≥ campaign.deadline.
  - Requires campaign.raised ≥ campaign.goal.
  - Requires campaign.claimed == false.
  - Transfers raised from the contract to the creator.
  - Sets campaign.claimed = true.
  - Increments creator’s claim-count and awards badge when new count ≥ 2 (if not already present).
  - Returns ok true.

## Read-only functions

- (get-campaign (id uint)) → (response {creator: principal, goal: uint, raised: uint, deadline: uint, claimed: bool} uint)
  - Returns campaign if id is valid and exists; else err ERR-NOT-FOUND.

- (get-donations (id uint) (user principal)) → (response uint none)
  - If id is valid and a donation exists, returns that amount; otherwise returns ok u0.

- (has-badge (user principal)) → (response bool none)
  - true if a badge entry exists for user.

- (get-campaign-counter) → (response uint none)
  - Returns current campaign-counter.

- (get-claim-count (user principal)) → (response uint none)
  - Returns user’s successful claim count (default u0).

- (get-validation-constants) → (response {min-goal: uint, max-goal: uint, min-donation: uint, max-campaign-duration: uint} none)

## Internal helpers

- is-valid-goal(goal): goal within [MIN-GOAL, MAX-GOAL].
- is-valid-deadline(deadline): deadline > now and within MAX-CAMPAIGN-DURATION.
- is-valid-amount(amount): amount ≥ MIN-DONATION.
- is-valid-campaign-id(id): id < campaign-counter.
- update-claim-count(user): increments claim-count; sets badges[user] = true when new-count ≥ 2 and badge not present.

## Funds flow

- Donations: stx-transfer? from donor to contract principal.
- Claims: stx-transfer? from contract principal to campaign creator.

## Notes and limitations

- No refunds: there is no function to refund donors if a campaign fails.
- Per-donor amounts overwrite: donations map keeps only the most recent amount per {campaign, funder}.
- Badge presence is used as the indicator of award; its bool value is not otherwise read.
