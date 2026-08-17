"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BrandWordmark } from "../brand";

import { buildDemoAuction, createSponsoredSession, DEMO_FREQUENCIES, isDemoFrequencyId, suggestDemoMinimumTakeHomeRange, type DemoActionReward, type DemoBid, type DemoFrequencyId, type DemoMarketContext, type DemoProfile, type DemoRewardType } from "../../lib/demo/market";
import { creditDemoAction, creditDemoPlacement, INITIAL_DEMO_CASH_REWARDS } from "../../lib/demo/reward-state";

type Stage = "intro" | "account" | "privacy" | "ready" | "auction" | "session" | "no-fill";
type SharedField = "projects" | "repos" | "descriptions" | "stack" | "location" | "tokens" | "tier";

const SHARED_FIELDS: ReadonlyArray<{ id: SharedField; label: string; value: string }> = [
  { id: "projects", label: "Project names", value: "Receipt API, Cookbook Club" },
  { id: "repos", label: "Public GitHub repos", value: "maya/receipt-api" },
  { id: "descriptions", label: "Project descriptions", value: "A receipt API for small merchants" },
  { id: "stack", label: "Tech stack", value: "TypeScript, Cloudflare, Postgres" },
  { id: "location", label: "Location", value: "Brooklyn, NY" },
  { id: "tokens", label: "Token usage", value: "1.2M / month" },
  { id: "tier", label: "Subscription tier", value: "Pro" },
];

const INITIAL_SHARED: Record<SharedField, boolean> = {
  projects: true,
  repos: true,
  descriptions: true,
  stack: true,
  location: false,
  tokens: false,
  tier: true,
};

const BASE_TASKS = [
  { title: "Ship auth callback", project: "receipt-api" },
  { title: "Write receipt schema", project: "receipt-api" },
  { title: "Plan Cookbook Club", project: "cookbook" },
];

function money(minor: number) {
  return `$${(minor / 100).toFixed(2)}`;
}

function rewardValue(bid: DemoBid) {
  return bid.rewardType === "cash" ? bid.receiverTakeHomeMinor : bid.valueMinor;
}

function rewardLiftValue(bid: DemoBid) {
  return bid.rewardType === "cash" ? bid.profileBoostTakeHomeMinor : bid.profileBoostValueMinor;
}

function rewardLabel(reward: DemoRewardType) {
  if (reward === "cash") return "Test cash";
  if (reward === "credits") return "Test product credits";
  return "Illustrative discount";
}

export function DemoExperience() {
  const [stage, setStage] = useState<Stage>("intro");
  const [name, setName] = useState("Maya Chen");
  const [email, setEmail] = useState("maya@example.com");
  const [projectName, setProjectName] = useState("Receipt API");
  const [projectDescription, setProjectDescription] = useState("A TypeScript API running on Cloudflare with Postgres");
  const [minimumReward, setMinimumReward] = useState("0.50");
  const [frequency, setFrequency] = useState<DemoFrequencyId>("twice_weekly");
  const [shared, setShared] = useState(INITIAL_SHARED);
  const [acceptedRewards, setAcceptedRewards] = useState<DemoRewardType[]>(["cash", "credits", "discounts"]);
  const [visibleBids, setVisibleBids] = useState(0);
  const [cashRewards, setCashRewards] = useState(INITIAL_DEMO_CASH_REWARDS);
  const [creditBalanceMinor, setCreditBalanceMinor] = useState(0);
  const [discountCount, setDiscountCount] = useState(0);

  const minimumRewardValue = Number(minimumReward);
  const minimumRewardIsValid = /^\d+(?:\.\d{0,2})?$/.test(minimumReward)
    && Number.isFinite(minimumRewardValue)
    && minimumRewardValue >= 0
    && minimumRewardValue <= 1_000_000;
  const minimumRewardMinor = minimumRewardIsValid ? Math.round(minimumRewardValue * 100) : 0;
  const sharedLabels = useMemo(() => SHARED_FIELDS.filter((field) => shared[field.id]).map((field) => field.label), [shared]);
  const frequencyOption = DEMO_FREQUENCIES[frequency];
  const frequencySlots = frequencyOption.slots;
  const marketContext = useMemo<DemoMarketContext>(() => ({
    projectName: shared.projects ? projectName : "",
    projectDescription: shared.descriptions ? projectDescription : "",
    sharedSignalCount: sharedLabels.length,
  }), [projectDescription, projectName, shared.descriptions, shared.projects, sharedLabels.length]);
  const auctionProfile = useMemo<DemoProfile>(() => ({
    ...marketContext,
    minimumTakeHomeMinor: minimumRewardMinor,
    acceptedRewards,
  }), [acceptedRewards, marketContext, minimumRewardMinor]);
  const auction = useMemo(() => buildDemoAuction(auctionProfile), [auctionProfile]);
  const suggestedMinimum = useMemo(() =>
    suggestDemoMinimumTakeHomeRange(marketContext, frequency), [frequency, marketContext]);

  const sponsoredSession = useMemo(() => auction.status === "filled" ? createSponsoredSession(auction) : null, [auction]);
  const previewBid = auction.status === "filled" ? auction.winner : auction.bids[0];
  const placementRewardMinor = previewBid ? rewardValue(previewBid) : 0;
  const profileLiftMinor = previewBid ? rewardLiftValue(previewBid) : 0;
  const previewRewardLabel = previewBid ? rewardLabel(previewBid.rewardType) : "Selected reward";
  const walletSummary = discountCount > 0
    ? `${discountCount} Test discount${discountCount === 1 ? "" : "s"}`
    : creditBalanceMinor > 0
      ? `${money(creditBalanceMinor)} Test credits`
      : `${money(cashRewards.balanceMinor)} Test cash`;

  useEffect(() => {
    if (stage !== "ready") return;
    const poll = window.setTimeout(() => {
      setVisibleBids(0);
      setStage("auction");
    }, 1_500);
    return () => window.clearTimeout(poll);
  }, [stage]);

  useEffect(() => {
    if (stage !== "auction") return;
    const timers = auction.bids.map((_, index) => window.setTimeout(() => setVisibleBids(index + 1), 550 + index * 620));
    const finish = window.setTimeout(() => {
      if (auction.status === "no_fill") {
        setStage("no-fill");
        return;
      }
      const winner = auction.winner;
      if (winner.rewardType === "cash") {
        setCashRewards((current) => creditDemoPlacement(current, auction.auctionId, winner.receiverTakeHomeMinor));
      } else if (winner.rewardType === "credits") {
        setCreditBalanceMinor((current) => current + winner.valueMinor);
      } else {
        setDiscountCount((current) => current + 1);
      }
      setStage("session");
    }, 550 + auction.bids.length * 620 + 850);
    return () => {
      timers.forEach(window.clearTimeout);
      window.clearTimeout(finish);
    };
  }, [auction, stage]);

  function toggleShared(id: SharedField) {
    setShared((current) => ({ ...current, [id]: !current[id] }));
  }

  function toggleReward(reward: DemoRewardType) {
    setAcceptedRewards((current) => current.includes(reward)
      ? current.length === 1 ? current : current.filter((item) => item !== reward)
      : [...current, reward]);
  }

  function completeAction(reward: DemoActionReward) {
    setCashRewards((current) => creditDemoAction(current, reward));
  }

  function startOver() {
    setStage("intro");
    setVisibleBids(0);
    setCashRewards(INITIAL_DEMO_CASH_REWARDS);
    setCreditBalanceMinor(0);
    setDiscountCount(0);
    setShared(INITIAL_SHARED);
    setAcceptedRewards(["cash", "credits", "discounts"]);
  }

  return (
    <main className={`demo-page demo-stage-${stage}`}>
      <nav className="demo-nav" aria-label="Demo navigation">
        <Link href="/" className="demo-wordmark" aria-label="Ad Daddy"><BrandWordmark /></Link>
        <div className="demo-nav-status">
          <span className="demo-live-dot" aria-hidden="true" />
          Interactive demo · No real money
        </div>
        {stage === "intro" ? <span className="demo-step">01 / 04</span> : <button className="demo-reset" type="button" onClick={startOver}>Start over</button>}
      </nav>

      {stage === "intro" && (
        <section className="demo-intro">
          <p className="demo-kicker">A sponsored session marketplace</p>
          <h1>Earn while<br />you build.</h1>
          <p>Create a demo profile, invite automated bidders, and watch one sponsored session appear beside your work.</p>
          <button type="button" onClick={() => setStage("account")}>Create a demo account</button>
          <small>Takes about one minute. Everything is simulated.</small>
        </section>
      )}

      {stage === "account" && (
        <section className="demo-onboarding" aria-labelledby="account-title">
          <div className="demo-onboarding-copy">
            <span>01 · Your demo account</span>
            <h1 id="account-title">Who gets<br />the offers?</h1>
            <p>This stays in your browser. We only use it to make the demo feel like yours.</p>
          </div>
          <form className="demo-form" onSubmit={(event) => { event.preventDefault(); setStage("privacy"); }}>
            <label>Name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>Email<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label>Primary project<input required value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label>
            <label>What are you building?<textarea required value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} /></label>
            <button type="submit">Choose what advertisers see <span aria-hidden="true">→</span></button>
          </form>
        </section>
      )}

      {stage === "privacy" && (
        <section className="demo-privacy" aria-labelledby="privacy-title">
          <header>
            <span>02 · Your terms</span>
            <h1 id="privacy-title">More context.<br />Better bids.</h1>
            <p>Advertisers only receive what you approve. More approved context can unlock tighter matches and higher placement bids; less context keeps your profile more private.</p>
          </header>
          <div className="demo-permission-panel">
            <div className="demo-permission-list">
              {SHARED_FIELDS.map((field) => (
                <label key={field.id} className={shared[field.id] ? "is-selected" : ""}>
                  <input type="checkbox" checked={shared[field.id]} onChange={() => toggleShared(field.id)} />
                  <span><b>{field.label}</b><small>{field.value}</small></span>
                  <i aria-hidden="true">{shared[field.id] ? "On" : "Off"}</i>
                </label>
              ))}
            </div>
            <aside className="demo-terms">
              <label>Minimum cash take-home<div className="demo-money-input"><span>$</span><input required type="number" min="0" max="1000000" step="0.01" inputMode="decimal" value={minimumReward} onChange={(event) => setMinimumReward(event.target.value)} aria-invalid={!minimumRewardIsValid} aria-describedby="minimum-reward-help" aria-label="Minimum cash take-home in dollars" /></div></label>
              <small id="minimum-reward-help" className={minimumRewardIsValid ? "demo-field-help" : "demo-field-help is-error"}>{minimumRewardIsValid ? "A finite amount from $0 to $1,000,000." : "Enter a nonnegative amount with no more than two decimals."}</small>
              <label>Ad frequency<select value={frequency} onChange={(event) => {
                if (isDemoFrequencyId(event.target.value)) setFrequency(event.target.value);
              }}>{Object.entries(DEMO_FREQUENCIES).map(([id, option]) => <option key={id} value={id}>{option.label}</option>)}</select></label>
              <div className="demo-price-guide">
                <span>Similar profiles ask</span>
                <strong>{money(suggestedMinimum.lowMinor)}–{money(suggestedMinimum.highMinor)}</strong>
                <small>Per placement at {frequencyOption.label.toLowerCase()}, based on {suggestedMinimum.sampleSize} comparable demo bids.</small>
                <button type="button" onClick={() => setMinimumReward((suggestedMinimum.lowMinor / 100).toFixed(2))}>Use suggested minimum</button>
              </div>
              <fieldset>
                <legend>Accepted rewards</legend>
                {(["cash", "credits", "discounts"] as const).map((reward) => (
                  <label key={reward}><input type="checkbox" checked={acceptedRewards.includes(reward)} onChange={() => toggleReward(reward)} /><span>{reward === "cash" ? "Test cash" : reward[0].toUpperCase() + reward.slice(1)}</span></label>
                ))}
              </fieldset>
              <div className="demo-market-preview">
                <div><span>Approved context</span><b>{sharedLabels.length} / {SHARED_FIELDS.length} signals</b><small>Demo offer lift: +{money(profileLiftMinor)} {previewRewardLabel}</small></div>
                <div><span>Frequency</span><b>{frequencySlots} placement slots / month</b><small>You can pause or change this at any time</small></div>
                <div><span>If every slot fills</span><strong>{money(placementRewardMinor * frequencySlots)}</strong><small>Illustrative {previewRewardLabel.toLowerCase()} value; action bonuses are extra</small></div>
              </div>
              <div className="demo-takehome"><span>Your minimum placement take-home</span><strong>{minimumRewardIsValid ? money(minimumRewardMinor) : "—"}</strong><small>80% receiver · 20% Ad Daddy on cash. Noncash offers require a $0 minimum.</small></div>
              <button type="button" disabled={!minimumRewardIsValid} onClick={() => minimumRewardIsValid && setStage("ready")}>Turn on background delivery <span aria-hidden="true">→</span></button>
            </aside>
          </div>
        </section>
      )}

      {(stage === "ready" || stage === "auction" || stage === "session" || stage === "no-fill") && (
        <section className="demo-workspace" aria-label="Simulated Codex workspace">
          <div className="demo-workspace-caption">
            <div><span>03 · Your agent</span><h1>The ad arrives<br />where you work.</h1></div>
            <p>{stage === "ready" ? "One opt-in is enough. Ad Daddy polls on your schedule and only creates a task when an offer clears your terms." : stage === "auction" ? "A background poll found demand. Automated advertisers are competing for this placement." : stage === "no-fill" ? "No offer cleared your terms, so no sponsored session was created." : "The winner appears as a new, clearly labeled task—not a banner pasted over your work."}</p>
          </div>
          <p className="demo-illustrative-note">Illustrative prototype. Named advertisers, ad copy, and bids are fictional demo data—not endorsements or partnerships.</p>
          <div className="codex-window">
            <div className="codex-titlebar">
              <div className="window-dots" aria-hidden="true"><i /><i /><i /></div>
              <span>{stage === "session" && sponsoredSession ? sponsoredSession.title : projectName}</span>
              <div className="codex-title-actions"><span>Open in⌄</span><i aria-hidden="true">···</i></div>
            </div>
            <aside className="codex-sidebar">
              <div className="codex-brand">Codex <span>⌄</span></div>
              <button type="button" className="codex-new">＋ <span>New task</span></button>
              <div className="codex-sidebar-label">Today</div>
              {stage === "session" && sponsoredSession && (
                <button type="button" className="codex-task is-sponsored is-active">
                  <span className="codex-sponsor-mark">AD</span>
                  <span><b>{sponsoredSession.title}</b><small>Sponsored · {sponsoredSession.advertiserName}</small></span>
                </button>
              )}
              {BASE_TASKS.map((task, index) => (
                <button key={task.title} type="button" className={`codex-task ${stage !== "session" && index === 0 ? "is-active" : ""}`}>
                  <span className="codex-task-icon">□</span><span><b>{task.title}</b><small>▱ {task.project}</small></span>
                </button>
              ))}
              <div className="codex-sidebar-label">Yesterday</div>
              <button type="button" className="codex-task"><span className="codex-task-icon">□</span><span><b>Fix webhook retries</b><small>▱ receipt-api</small></span></button>
              <div className="codex-user"><span>MC</span><b>{name}</b><small>{walletSummary}</small></div>
            </aside>
            <div className="codex-thread" aria-live="polite">
              {stage === "ready" && (
                <div className="codex-ready">
                  <div className="codex-response">
                    <span className="codex-response-label"><i className="demo-live-dot" aria-hidden="true" /> Background polling active</span>
                    <p>Ad Daddy can use <b>{sharedLabels.length} approved profile fields</b>, create up to <b>{frequencySlots} sponsored tasks / month</b>, and accept nothing below <b>{money(minimumRewardMinor)}</b>.</p>
                    <p>You keep working. A matched ad appears here automatically; advertiser content stays display-only.</p>
                    <small>Polling securely for an eligible sponsorship…</small>
                  </div>
                </div>
              )}
              {stage === "auction" && (
                <div className="auction-view">
                  <div className="auction-header"><span>Background match · Live auction</span><b>{visibleBids} / {auction.bids.length} bidders</b></div>
                  <h2>Who wants to meet<br />{name.split(" ")[0]}?</h2>
                  <div className="auction-bids">
                    {auction.bids.map((bid, index) => (
                      <div key={bid.advertiserId} className={`auction-bid ${visibleBids > index ? "is-visible" : ""}`}>
                        <span style={{ background: bid.accent }}>{bid.advertiserName.slice(0, 1)}</span>
                        <div><b>{bid.advertiserName}</b><small>{bid.matchReason}</small>{visibleBids > index && bid.rewardType === "cash" && <small className="auction-bid-split">Gross {money(bid.grossAmountMinor)} · Ad Daddy {money(bid.operatorFeeMinor)} · profile lift +{money(bid.profileBoostMinor)}</small>}</div>
                        <div className="auction-bid-offer"><strong>{visibleBids > index ? money(rewardValue(bid)) : "—"}</strong><small>{visibleBids > index ? bid.rewardType === "cash" ? "Guaranteed take-home" : rewardLabel(bid.rewardType) : "Pending"}</small></div>
                      </div>
                    ))}
                  </div>
                  <p className="auction-note">Bidders compete on the guaranteed placement payout first. Optional action bonuses are locked into the winning offer and only pay after the stated event is verified.</p>
                </div>
              )}
              {stage === "no-fill" && (
                <div className="no-fill-view">
                  <span>No sponsored session created</span>
                  <h2>No offer cleared<br />your terms.</h2>
                  <p>{auction.status === "no_fill" && auction.reason === "minimum_not_met" ? `The available offers did not meet your ${money(minimumRewardMinor)} minimum take-home.` : "No available campaign offered one of your selected reward types."}</p>
                  <button type="button" onClick={() => { setVisibleBids(0); setStage("privacy"); }}>Adjust preferences <span aria-hidden="true">→</span></button>
                  <small>No real money moved, and no sidebar session was created.</small>
                </div>
              )}
              {stage === "session" && sponsoredSession && auction.status === "filled" && (
                <article className="sponsored-thread">
                  <div className="sponsored-disclosure"><span>AD</span><b>Sponsored via Ad Daddy</b><i>Display only</i></div>
                  <div className="sponsored-reward"><span>Earned on placement</span><strong>{money(sponsoredSession.rewardMinor)}</strong><small>{rewardLabel(sponsoredSession.rewardType)} · Already yours · No real money</small></div>
                  <p className="sponsored-brand">A message from {sponsoredSession.advertiserName}</p>
                  <h2>{sponsoredSession.headline}</h2>
                  <p className="sponsored-body">{sponsoredSession.body}</p>
                  {auction.winner.rewardType === "cash" && (
                    <>
                      <div className="sponsored-potential"><span>Potential total</span><strong>{money(sponsoredSession.potentialRewardMinor)}</strong><small>Placement plus every verified action. Optional actions never affect what you already earned.</small></div>
                      <div className="sponsored-reward-ladder" aria-label="Optional action rewards">
                        {sponsoredSession.actionRewards.map((reward, index) => {
                          const completed = cashRewards.completedActionIds.includes(reward.id);
                          return (
                            <div key={reward.id} className={completed ? "is-complete" : ""}>
                              <span>0{index + 1}</span>
                              <p><b>{reward.label}</b><small>{reward.description} · {reward.verification}</small></p>
                              <strong>+{money(reward.receiverTakeHomeMinor)}</strong>
                              <button type="button" disabled={completed} onClick={() => completeAction(reward)}>{completed ? "Earned" : "Try action"}</button>
                            </div>
                          );
                        })}
                      </div>
                      <p className="sponsored-optional-note">Optional actions are your choice. Advertiser pays only after verification; Ad Daddy takes 20%; you receive 80%.</p>
                      <div className="sponsored-cash-split"><span>Placement gross <b>{money(auction.winner.grossAmountMinor)}</b></span><span>Ad Daddy fee <b>−{money(auction.winner.operatorFeeMinor)}</b></span><span>Earned on placement <b>{money(auction.winner.receiverTakeHomeMinor)}</b></span></div>
                    </>
                  )}
                  {auction.winner.rewardType !== "cash" && <button type="button" className="sponsored-cta">{sponsoredSession.action} <span aria-hidden="true">↗</span></button>}
                  <div className="sponsored-context"><span>Matched using</span><p>{sponsoredSession.matchedSignals.length > 0 ? sponsoredSession.matchedSignals.map((match) => `${match.signal}: ${match.terms.join(", ")}`).join(" · ") : "No profile signal—broad campaign"}</p></div>
                  <div className="sponsored-safety">This sponsored session cannot run tools, install software, make purchases, or modify your work.</div>
                  <div className="sponsored-actions"><button type="button">Hide</button><button type="button">Block {sponsoredSession.advertiserName}</button><button type="button">Report</button></div>
                </article>
              )}
            </div>
            <aside className="codex-inspector">
              <div><span>Background delivery</span><b>On</b><small>{stage === "ready" ? "Polling now" : stage === "auction" ? "Offer found" : "Next poll follows your cadence"}</small></div>
              <div><span>Demo rewards</span><strong>{cashRewards.balanceMinor > 0 ? money(cashRewards.balanceMinor) : creditBalanceMinor > 0 ? money(creditBalanceMinor) : discountCount}</strong><small>{cashRewards.balanceMinor > 0 ? "Test cash" : creditBalanceMinor > 0 ? "Test product credits" : discountCount > 0 ? "Illustrative discounts" : "No real money"}</small></div>
              <div><span>Frequency</span><b>{frequencyOption.label}</b></div>
              <div><span>Shared</span><b>{sharedLabels.length} fields</b></div>
              <div><span>Minimum</span><b>{money(minimumRewardMinor)}</b></div>
              {sponsoredSession && <div><span>Potential / ad</span><b>{money(sponsoredSession.potentialRewardMinor)}</b><small>Only if every action verifies</small></div>}
            </aside>
          </div>
          {stage === "session" && <button type="button" className="demo-finish" onClick={startOver}>Run the demo again</button>}
        </section>
      )}
    </main>
  );
}
