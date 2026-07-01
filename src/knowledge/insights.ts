// Pure analytics helpers for the systems-of-action tools. These operate on the merchant's OWN
// account data (products + orders) — honest, own-account signal. Cross-merchant / personalized
// intelligence is a future data-flywheel feature and is NOT fabricated here.

export interface InsightProduct {
  product_uuid: string;
  name?: string;
  price?: number;
  status?: string;
}

export interface InsightOrder {
  order_uuid: string;
  channel?: string;
  total?: number;
  items?: { product_name?: string }[];
}

export interface Insight {
  category: string;
  finding: string;
  confidence: 'high' | 'medium' | 'low';
  recommendation: string;
}

export interface OptimizeProposal {
  product_uuid: string;
  product_name?: string;
  action: 'pause' | 'regenerate_design' | 'lower_price' | 'remove_from_channel';
  rationale: string;
}

function confidenceFor(n: number): Insight['confidence'] {
  if (n >= 20) return 'high';
  if (n >= 5) return 'medium';
  return 'low';
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

export function salesCountByName(orders: InsightOrder[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const o of orders) {
    for (const it of o.items ?? []) {
      const name = (it.product_name ?? '').trim().toLowerCase();
      if (name) m.set(name, (m.get(name) ?? 0) + 1);
    }
  }
  return m;
}

export function deriveInsights(products: InsightProduct[], orders: InsightOrder[]): Insight[] {
  const insights: Insight[] = [];

  if (orders.length === 0) {
    insights.push({
      category: 'sales',
      finding: 'No orders yet, so there is no sales signal to analyze.',
      confidence: 'low',
      recommendation:
        'Publish a few designs; recommendations personalize as orders come in. You have ' +
        `${products.length} product(s) live.`,
    });
    return insights;
  }

  const conf = confidenceFor(orders.length);

  const byName = salesCountByName(orders);
  let top: [string, number] | undefined;
  for (const e of byName) if (!top || e[1] > top[1]) top = e;
  if (top) {
    insights.push({
      category: 'top_product',
      finding: `Your best seller by order volume is "${titleCase(top[0])}" (${top[1]} order line(s)).`,
      confidence: conf,
      recommendation: 'Consider variations or complementary designs in the same theme.',
    });
  }

  const byChannel = new Map<string, number>();
  for (const o of orders) {
    const c = o.channel ?? 'unknown';
    byChannel.set(c, (byChannel.get(c) ?? 0) + 1);
  }
  let topCh: [string, number] | undefined;
  for (const e of byChannel) if (!topCh || e[1] > topCh[1]) topCh = e;
  if (topCh) {
    insights.push({
      category: 'channel_performance',
      finding: `${topCh[0]} is your highest-volume channel (${topCh[1]} of ${orders.length} orders).`,
      confidence: conf,
      recommendation: `List new products on ${topCh[0]} first.`,
    });
  }

  const totals = orders.map((o) => o.total ?? 0).filter((t) => t > 0);
  if (totals.length) {
    const aov = totals.reduce((a, b) => a + b, 0) / totals.length;
    insights.push({
      category: 'pricing',
      finding: `Average order value is $${aov.toFixed(2)} across ${totals.length} order(s).`,
      confidence: conf,
      recommendation:
        aov < 30 ? 'Test premium garments or bundles to lift AOV.' : 'AOV is healthy; keep the current price band.',
    });
  }

  insights.push({
    category: 'note',
    finding: 'These insights are from your own account data only.',
    confidence: 'high',
    recommendation: 'Cross-merchant trend intelligence will grow as the data flywheel matures (future).',
  });

  return insights;
}

/** Products with zero recorded sales -> candidates to pause / refresh (a conservative signal). */
export function findUnderperformers(
  products: InsightProduct[],
  orders: InsightOrder[],
): OptimizeProposal[] {
  const sold = salesCountByName(orders);
  const proposals: OptimizeProposal[] = [];
  for (const p of products) {
    if ((p.status ?? '').toLowerCase() === 'archived') continue;
    const name = (p.name ?? '').trim().toLowerCase();
    const count = name ? (sold.get(name) ?? 0) : 0;
    if (count === 0) {
      proposals.push({
        product_uuid: p.product_uuid,
        product_name: p.name,
        action: 'pause',
        rationale: 'No recorded sales; consider pausing (archiving) or refreshing the design.',
      });
    }
  }
  return proposals;
}
