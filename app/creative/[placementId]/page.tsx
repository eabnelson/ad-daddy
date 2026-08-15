import { placementDeliveryRepository } from "../../../lib/marketplace/placement-registry.ts";

export default async function CreativePage({ params }: { params: Promise<{ placementId: string }> }) {
  const { placementId } = await params;
  const record = placementId.length <= 128
    ? await placementDeliveryRepository.get(placementId)
    : undefined;
  if (!record) {
    return <CreativeState status="expired" title="This sponsored placement is unavailable." />;
  }
  if (["expired", "blocked", "reported"].includes(record.status)) {
    return <CreativeState status={record.status} title={`This sponsored placement is ${record.status}.`} />;
  }
  const { payload } = record.validatedCreative;
  return (
    <main className="creative-shell">
      <meta httpEquiv="Content-Security-Policy" content={record.validatedCreative.contentSecurityPolicy} />
      <article className="creative-card" aria-labelledby="creative-title">
        <p className="creative-disclosure">Sponsored via Ad Daddy</p>
        <p>{payload.advertiser.displayName}</p>
        <h1 id="creative-title">{payload.title}</h1>
        <p>{payload.creative.body}</p>
        {payload.creative.implementationPrompt ? (
          <section aria-labelledby="implementation-prompt">
            <h2 id="implementation-prompt">Optional implementation idea</h2>
            <pre>{payload.creative.implementationPrompt}</pre>
            <p>Display only. Start a separate task to act on this idea.</p>
          </section>
        ) : null}
        <dl>
          <div><dt>Your reward</dt><dd>${(payload.payout.amountMinor / 100).toFixed(2)} {payload.payout.currency}</dd></div>
          <div><dt>Why this matched</dt><dd>{payload.signalsUsed.join(", ")}</dd></div>
        </dl>
        {record.validatedCreative.destinationUrl ? (
          <a href={record.validatedCreative.destinationUrl} rel="noopener noreferrer nofollow sponsored">View advertiser offer</a>
        ) : null}
        <form method="post" action={`/api/v1/placements/${encodeURIComponent(placementId)}/receipt`} aria-label="Sponsored placement controls">
          <button name="action" value="hide">Hide</button>
          <button name="action" value="block_advertiser">Block advertiser</button>
          <button name="action" value="report">Report</button>
        </form>
      </article>
    </main>
  );
}

function CreativeState({ status, title }: { status: string; title: string }) {
  return (
    <main className="creative-shell">
      <meta httpEquiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" />
      <section className="creative-card" role="status" aria-live="polite">
        <p className="creative-disclosure">Sponsored via Ad Daddy</p>
        <h1>{title}</h1>
        <p>Status: {status}</p>
      </section>
    </main>
  );
}
