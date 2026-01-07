import { describe, expect, it } from "vitest";
import { tx } from "@hirosystems/clarinet-sdk";
import { Cl } from "@stacks/transactions";

const CONTRACT_NAME = "fiducia";
const MIN_GOAL = 1_000_000;
const MIN_DONATION = 100_000;

const accounts = simnet.getAccounts();
const wallet1 = accounts.get("wallet_1");
const wallet2 = accounts.get("wallet_2");
const wallet3 = accounts.get("wallet_3");

if (!wallet1 || !wallet2 || !wallet3) {
  throw new Error("Expected predefined wallets to be available");
}

const advanceToBlockHeight = async (target: number) => {
  while (simnet.blockHeight < target) {
    await simnet.mineBlock([]);
  }
};

const createCampaignTx = (sender: string, goal: number, deadline: number) =>
  tx.callPublicFn(CONTRACT_NAME, "create-campaign", [Cl.uint(goal), Cl.uint(deadline)], sender);

const donateTx = (sender: string, campaignId: number, amount: number) =>
  tx.callPublicFn(CONTRACT_NAME, "donate", [Cl.uint(campaignId), Cl.uint(amount)], sender);

describe("fiducia smart contract", () => {
  it("stores metadata when a campaign is created with valid inputs", async () => {
    const deadline = simnet.blockHeight + 10;
    const block = await simnet.mineBlock([createCampaignTx(wallet1, MIN_GOAL, deadline)]);
    expect(block[0].result).toBeOk(Cl.uint(0));

    const counter = simnet.callReadOnlyFn(CONTRACT_NAME, "get-campaign-counter", [], wallet1);
    expect(counter.result).toBeOk(Cl.uint(1));

    const campaign = simnet.callReadOnlyFn(
      CONTRACT_NAME,
      "get-campaign",
      [Cl.uint(0)],
      wallet1,
    );
    expect(campaign.result).toBeOk(
      Cl.tuple({
        creator: Cl.standardPrincipal(wallet1),
        goal: Cl.uint(MIN_GOAL),
        raised: Cl.uint(0),
        deadline: Cl.uint(deadline),
        claimed: Cl.bool(false),
        finalized: Cl.bool(false),
      }),
    );
  });

  it("rejects campaigns that do not meet the minimum goal", async () => {
    const deadline = simnet.blockHeight + 10;
    const block = await simnet.mineBlock([
      createCampaignTx(wallet1, MIN_GOAL - 1, deadline),
    ]);
    expect(block[0].result).toBeErr(Cl.uint(409));
  });

  it("records donations and exposes per-funder amounts", async () => {
    const deadline = simnet.blockHeight + 10;
    await simnet.mineBlock([createCampaignTx(wallet1, MIN_GOAL, deadline)]);

    const donationAmount = MIN_DONATION;
    const donateBlock = await simnet.mineBlock([donateTx(wallet2, 0, donationAmount)]);
    expect(donateBlock[0].result).toBeOk(Cl.uint(donationAmount));

    const campaign = simnet.callReadOnlyFn(
      CONTRACT_NAME,
      "get-campaign",
      [Cl.uint(0)],
      wallet1,
    );
    expect(campaign.result).toBeOk(
      Cl.tuple({
        creator: Cl.standardPrincipal(wallet1),
        goal: Cl.uint(MIN_GOAL),
        raised: Cl.uint(donationAmount),
        deadline: Cl.uint(deadline),
        claimed: Cl.bool(false),
        finalized: Cl.bool(false),
      }),
    );

    const donation = simnet.callReadOnlyFn(
      CONTRACT_NAME,
      "get-donations",
      [Cl.uint(0), Cl.standardPrincipal(wallet2)],
      wallet2,
    );
    expect(donation.result).toBeOk(Cl.uint(donationAmount));
  });

  it("prevents donations that would exceed the campaign goal", async () => {
    const deadline = simnet.blockHeight + 10;
    await simnet.mineBlock([createCampaignTx(wallet1, MIN_GOAL, deadline)]);

    await simnet.mineBlock([donateTx(wallet2, 0, MIN_GOAL)]);
    const overfundBlock = await simnet.mineBlock([
      donateTx(wallet3, 0, MIN_DONATION),
    ]);
    expect(overfundBlock[0].result).toBeErr(Cl.uint(414));
  });

  it("allows refunds after deadline when the goal is not met", async () => {
    const deadline = simnet.blockHeight + 5;
    await simnet.mineBlock([createCampaignTx(wallet1, MIN_GOAL, deadline)]);
    await simnet.mineBlock([donateTx(wallet2, 0, MIN_DONATION)]);

    await advanceToBlockHeight(deadline);
    const refundBlock = await simnet.mineBlock([
      tx.callPublicFn(CONTRACT_NAME, "request-refund", [Cl.uint(0)], wallet2),
    ]);
    expect(refundBlock[0].result).toBeOk(Cl.uint(MIN_DONATION));

    const campaign = simnet.callReadOnlyFn(
      CONTRACT_NAME,
      "get-campaign",
      [Cl.uint(0)],
      wallet1,
    );
    expect(campaign.result).toBeOk(
      Cl.tuple({
        creator: Cl.standardPrincipal(wallet1),
        goal: Cl.uint(MIN_GOAL),
        raised: Cl.uint(0),
        deadline: Cl.uint(deadline),
        claimed: Cl.bool(false),
        finalized: Cl.bool(false),
      }),
    );

    const donation = simnet.callReadOnlyFn(
      CONTRACT_NAME,
      "get-donations",
      [Cl.uint(0), Cl.standardPrincipal(wallet2)],
      wallet2,
    );
    expect(donation.result).toBeOk(Cl.uint(0));
  });

  it("finalizes lapsed campaigns without transferring funds when the goal is unmet", async () => {
    const deadline = simnet.blockHeight + 5;
    await simnet.mineBlock([createCampaignTx(wallet1, MIN_GOAL, deadline)]);

    await advanceToBlockHeight(deadline);
    const finalizeBlock = await simnet.mineBlock([
      tx.callPublicFn(CONTRACT_NAME, "finalize-campaign", [Cl.uint(0)], wallet1),
    ]);
    expect(finalizeBlock[0].result).toBeOk(Cl.bool(false));

    const campaign = simnet.callReadOnlyFn(
      CONTRACT_NAME,
      "get-campaign",
      [Cl.uint(0)],
      wallet1,
    );
    expect(campaign.result).toBeOk(
      Cl.tuple({
        creator: Cl.standardPrincipal(wallet1),
        goal: Cl.uint(MIN_GOAL),
        raised: Cl.uint(0),
        deadline: Cl.uint(deadline),
        claimed: Cl.bool(false),
        finalized: Cl.bool(true),
      }),
    );
  });

  it("lets the creator claim funds once the goal is met and awards no badge yet", async () => {
    const deadline = simnet.blockHeight + 5;
    await simnet.mineBlock([createCampaignTx(wallet1, MIN_GOAL, deadline)]);
    await simnet.mineBlock([donateTx(wallet2, 0, MIN_GOAL)]);

    await advanceToBlockHeight(deadline);
    const claimBlock = await simnet.mineBlock([
      tx.callPublicFn(CONTRACT_NAME, "claim-funds", [Cl.uint(0)], wallet1),
    ]);
    expect(claimBlock[0].result).toBeOk(Cl.bool(true));

    const campaign = simnet.callReadOnlyFn(
      CONTRACT_NAME,
      "get-campaign",
      [Cl.uint(0)],
      wallet1,
    );
    expect(campaign.result).toBeOk(
      Cl.tuple({
        creator: Cl.standardPrincipal(wallet1),
        goal: Cl.uint(MIN_GOAL),
        raised: Cl.uint(MIN_GOAL),
        deadline: Cl.uint(deadline),
        claimed: Cl.bool(true),
        finalized: Cl.bool(true),
      }),
    );

    const claimCount = simnet.callReadOnlyFn(
      CONTRACT_NAME,
      "get-claim-count",
      [Cl.standardPrincipal(wallet1)],
      wallet1,
    );
    expect(claimCount.result).toBeOk(Cl.uint(1));

    const badge = simnet.callReadOnlyFn(
      CONTRACT_NAME,
      "has-badge",
      [Cl.standardPrincipal(wallet1)],
      wallet1,
    );
    expect(badge.result).toBeOk(Cl.bool(false));
  });

  it("awards a badge after two successful claims", async () => {
    const firstDeadline = simnet.blockHeight + 5;
    await simnet.mineBlock([createCampaignTx(wallet1, MIN_GOAL, firstDeadline)]);
    await simnet.mineBlock([donateTx(wallet2, 0, MIN_GOAL)]);
    await advanceToBlockHeight(firstDeadline);
    await simnet.mineBlock([
      tx.callPublicFn(CONTRACT_NAME, "claim-funds", [Cl.uint(0)], wallet1),
    ]);

    const secondDeadline = simnet.blockHeight + 5;
    await simnet.mineBlock([createCampaignTx(wallet1, MIN_GOAL, secondDeadline)]);
    await simnet.mineBlock([donateTx(wallet2, 1, MIN_GOAL)]);
    await advanceToBlockHeight(secondDeadline);
    await simnet.mineBlock([
      tx.callPublicFn(CONTRACT_NAME, "claim-funds", [Cl.uint(1)], wallet1),
    ]);

    const claimCount = simnet.callReadOnlyFn(
      CONTRACT_NAME,
      "get-claim-count",
      [Cl.standardPrincipal(wallet1)],
      wallet1,
    );
    expect(claimCount.result).toBeOk(Cl.uint(2));

    const badge = simnet.callReadOnlyFn(
      CONTRACT_NAME,
      "has-badge",
      [Cl.standardPrincipal(wallet1)],
      wallet1,
    );
    expect(badge.result).toBeOk(Cl.bool(true));
  });
});
