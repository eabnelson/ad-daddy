const controls = [
  ["Cadence", "At most 2 / week"],
  ["Minimum bid", "$0.50"],
  ["Your share", "80%"],
];

const steps = [
  {
    number: "01",
    title: "Your agent takes a snapshot",
    body: "A short-lived interest profile is created from the moment — without sending raw chats or files.",
  },
  {
    number: "02",
    title: "Approved advertisers bid",
    body: "The marketplace filters every offer against your price, category, privacy, and frequency rules.",
  },
  {
    number: "03",
    title: "One new session appears",
    body: "The winner arrives as a clearly labeled sponsored session, separate from the work you are doing.",
  },
];

function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export default function Home() {
  return (
    <main>
      <nav className="nav shell" aria-label="Primary navigation">
        <a className="brand" href="#top" aria-label="Ad Daddy home">
          <Mark />
          <span>Ad Daddy</span>
        </a>
        <div className="nav-links">
          <a href="#how-it-works">How it works</a>
          <a href="#protocol">Protocol</a>
        </div>
        <a className="nav-cta" href="#protocol">Read the spec</a>
      </nav>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <p className="eyebrow"><span /> An open ad market for agents</p>
          <h1>Your agent.<br />Your attention.<br /><em>Your terms.</em></h1>
          <p className="lede">
            Ad Daddy lets any AI agent find the highest-value sponsored placement,
            while you control the price, pace, privacy, and categories.
          </p>
          <div className="hero-actions">
            <a className="button primary" href="#how-it-works">See how it works <span>↘</span></a>
            <a className="button secondary" href="#principles">Why a new session?</a>
          </div>
          <div className="trust-row" aria-label="Product principles">
            <span>Portable skill</span>
            <span>Explicit disclosure</span>
            <span>User revenue</span>
          </div>
        </div>

        <div className="product-stage" aria-label="Example sponsored agent session">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="control-card">
            <div className="control-head">
              <div>
                <span className="mini-label">Your rules</span>
                <strong>Placement controls</strong>
              </div>
              <span className="status">Live</span>
            </div>
            <div className="control-grid">
              {controls.map(([label, value]) => (
                <div className="control-row" key={label}>
                  <span>{label}</span><strong>{value}</strong>
                </div>
              ))}
            </div>
          </div>

          <div className="auction-pill">
            <span className="pulse" />
            <span>Auction cleared</span>
            <strong>$1.24</strong>
          </div>

          <article className="session-card">
            <div className="session-top">
              <span className="sponsored">Sponsored session</span>
              <span className="payout">You earn $0.99</span>
            </div>
            <div className="sponsor-mark">L</div>
            <p className="session-kicker">Linear · Productivity</p>
            <h2>Plan the work.<br />Let progress flow.</h2>
            <p className="session-body">Built for the way product teams and their agents work together.</p>
            <div className="session-footer">
              <span>Why you&apos;re seeing this</span>
              <span className="open-arrow">↗</span>
            </div>
          </article>
        </div>
      </section>

      <section className="ticker" aria-label="Supported agent surfaces">
        <div>
          <span>ONE SKILL</span><i>◆</i><span>ANY AGENT</span><i>◆</i><span>USER CONTROLLED</span><i>◆</i>
          <span>ONE SKILL</span><i>◆</i><span>ANY AGENT</span><i>◆</i><span>USER CONTROLLED</span>
        </div>
      </section>

      <section className="how shell" id="how-it-works">
        <div className="section-heading">
          <p className="eyebrow"><span /> How it works</p>
          <h2>One moment.<br />Three clean steps.</h2>
          <p>No feed. No interruption. No invisible targeting.</p>
        </div>
        <div className="steps">
          {steps.map((step) => (
            <article className="step" key={step.number}>
              <span className="step-number">{step.number}</span>
              <div className="step-icon" aria-hidden="true"><Mark /></div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="principles" id="principles">
        <div className="shell principle-grid">
          <div>
            <p className="eyebrow light"><span /> The contract</p>
            <h2>Sponsored content<br />should behave differently.</h2>
          </div>
          <div className="principle-list">
            <article><span>01</span><div><h3>Separate by design</h3><p>Ads never enter the active conversation, alter agent output, or become tool instructions.</p></div></article>
            <article><span>02</span><div><h3>Ephemeral by default</h3><p>Targeting uses a point-in-time profile that expires. Raw prompts, files, and chat history stay private.</p></div></article>
            <article><span>03</span><div><h3>Economics you can inspect</h3><p>See the winning bid, your payout, and the operator fee on every placement.</p></div></article>
          </div>
        </div>
      </section>

      <section className="protocol shell" id="protocol">
        <div className="protocol-copy">
          <p className="eyebrow"><span /> Agent-agnostic by design</p>
          <h2>A portable skill.<br />A tiny adapter.</h2>
          <p>
            The open skill defines when to run an auction, what context can leave the device,
            and how a winner is chosen. Each host adapter translates one safe action:
            <strong> create a labeled session.</strong>
          </p>
          <a className="text-link" href="#architecture">View the minimal architecture <span>→</span></a>
        </div>
        <div className="stack" id="architecture" aria-label="Ad Daddy architecture">
          <div className="stack-card lime"><span>01</span><strong>Ad Daddy skill</strong><small>Policy · cadence · privacy</small></div>
          <div className="connector">↓ signed context envelope</div>
          <div className="stack-card coral"><span>02</span><strong>Auction service</strong><small>Filter · bid · settle</small></div>
          <div className="connector">↓ inert sponsored payload</div>
          <div className="stack-card ink"><span>03</span><strong>Host adapter</strong><small>Codex · Claude · any agent</small></div>
        </div>
      </section>

      <footer>
        <div className="shell footer-inner">
          <a className="brand inverse" href="#top"><Mark /><span>Ad Daddy</span></a>
          <p>The user-controlled marketplace for agent attention.</p>
          <a href="#top">Back to top ↑</a>
        </div>
      </footer>
    </main>
  );
}
