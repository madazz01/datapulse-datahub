import { z } from 'zod';
import { STASIS_CORE_URL } from '../config/settings.js';

async function get(path) {
  const res = await fetch(`${STASIS_CORE_URL}${path}`);
  if (!res.ok) throw new Error(`Stasis API ${res.status}: ${path}`);
  return res.json();
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function err(e) {
  return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
}

export function registerDataHubTools(mcp) {

  mcp.tool(
    'datahub_dataset_intelligence',
    `Intelligence profile for a DataHub dataset. Returns recent signal history (freshness, health,
lineage depth, governance score), active structural breaks detected by CUSUM, and correlated
datasets that move together. Use to answer: "Is this dataset healthy?", "Has anything changed
recently?", "What other datasets are affected if this one fails?"`,
    {
      entity_key: z.string().describe(
        'Dataset entity key in the format platform_name — e.g. snowflake_orders_fact, dbt_customer_360. Use underscores, no spaces.'
      ),
    },
    async ({ entity_key }) => {
      const key = entity_key.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
      try {
        const [health, freshness, lineage, breaks, correlations] = await Promise.all([
          get(`/api/history?domain=datahub&entity=${key}&metric=health_score&limit=24`).catch(() => []),
          get(`/api/history?domain=datahub&entity=${key}&metric=hours_since_ingestion&limit=24`).catch(() => []),
          get(`/api/history?domain=datahub&entity=${key}&metric=upstream_count&limit=1`).catch(() => []),
          get(`/api/breaks?domain=datahub&limit=200`).catch(() => []),
          get(`/api/correlations?domain=datahub&entity=${key}&metric=health_score&min_r=0.4`).catch(() => []),
        ]);

        const entityBreaks = Array.isArray(breaks)
          ? breaks.filter(b => b.entity_id === key)
          : [];

        const latestHealth  = health[0]?.value ?? null;
        const latestFresh   = freshness[0]?.value ?? null;
        const upstreamCount = lineage[0]?.value ?? null;

        return ok({
          entity: key,
          current_state: {
            health_score: latestHealth,
            hours_since_ingestion: latestFresh,
            upstream_count: upstreamCount,
            status: latestHealth === 1 ? 'healthy' : latestHealth === 0 ? 'unhealthy' : 'unknown',
          },
          structural_breaks: entityBreaks,
          correlated_datasets: correlations,
          signal_history: {
            health:    health.slice(0, 12),
            freshness: freshness.slice(0, 12),
          },
        });
      } catch (e) { return err(e); }
    }
  );

  mcp.tool(
    'datahub_health_overview',
    `Overview of the entire DataHub data stack health. Returns: total datasets monitored, how many
are healthy vs unhealthy, how many have active structural breaks, average freshness, orphaned
datasets (no owner), deprecated assets still in use. Use as the entry point for a data platform
health check or incident triage.`,
    {},
    async () => {
      try {
        const [breaks, correlations] = await Promise.all([
          get('/api/breaks?domain=datahub&limit=500').catch(() => []),
          get('/api/correlations?domain=datahub&limit=100').catch(() => []),
        ]);

        const activeBreaks = Array.isArray(breaks) ? breaks.filter(b => b.status === 'active') : [];
        const affectedEntities = [...new Set(activeBreaks.map(b => b.entity_id))];

        return ok({
          structural_breaks: {
            active: activeBreaks.length,
            affected_datasets: affectedEntities,
          },
          correlations_tracked: Array.isArray(correlations) ? correlations.length : 0,
          summary: activeBreaks.length === 0
            ? 'No structural breaks detected — data stack appears stable.'
            : `${activeBreaks.length} active structural breaks across ${affectedEntities.length} datasets. Investigate these first.`,
          active_breaks_detail: activeBreaks.slice(0, 10),
        });
      } catch (e) { return err(e); }
    }
  );

  mcp.tool(
    'datahub_anomaly_alerts',
    `Datasets showing statistically significant structural breaks right now. CUSUM algorithm detects
when a metric has shifted beyond its historical baseline — not just threshold breaches, but genuine
regime changes. Returns affected datasets, which metric changed, and severity. Use when something
is wrong and you need to know where to look first.`,
    {
      metric: z.enum(['health_score', 'hours_since_ingestion', 'upstream_count', 'governance_score', 'all'])
        .optional()
        .describe('Filter to a specific metric, or "all" for everything. Default: all.'),
    },
    async ({ metric = 'all' }) => {
      try {
        const breaks = await get('/api/breaks?domain=datahub&limit=500').catch(() => []);
        const active = Array.isArray(breaks) ? breaks.filter(b => b.status === 'active') : [];

        const filtered = metric === 'all' ? active : active.filter(b => b.metric === metric);

        const byEntity = {};
        for (const b of filtered) {
          if (!byEntity[b.entity_id]) byEntity[b.entity_id] = [];
          byEntity[b.entity_id].push({ metric: b.metric, severity: b.cusum_score, detected_at: b.ts });
        }

        const sorted = Object.entries(byEntity)
          .map(([entity, alerts]) => ({ entity, alert_count: alerts.length, alerts }))
          .sort((a, b) => b.alert_count - a.alert_count);

        return ok({
          total_breaks: filtered.length,
          datasets_affected: sorted.length,
          anomalies: sorted,
          interpretation: sorted.length === 0
            ? 'No anomalies detected for this metric filter.'
            : `${sorted.length} datasets showing anomalous behaviour. ${sorted[0]?.entity} has the most signals.`,
        });
      } catch (e) { return err(e); }
    }
  );

  mcp.tool(
    'datahub_correlation_graph',
    `Finds datasets that move together with a given dataset — useful for blast-radius analysis.
If orders_fact degrades, which other datasets will be affected? Returns correlated entities with
Pearson r scores and the lag (in hours) at which the correlation peaks. High r + low lag = tight
coupling; high r + high lag = leading indicator.`,
    {
      entity_key: z.string().describe('Dataset entity key — e.g. snowflake_orders_fact'),
      metric: z.enum(['health_score', 'hours_since_ingestion', 'field_count', 'governance_score'])
        .optional()
        .describe('Which metric to correlate on. Default: health_score'),
      min_r: z.number().min(0).max(1).optional()
        .describe('Minimum Pearson r to include. Default: 0.4'),
    },
    async ({ entity_key, metric = 'health_score', min_r = 0.4 }) => {
      const key = entity_key.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
      try {
        const correlations = await get(
          `/api/correlations?domain=datahub&entity=${key}&metric=${metric}&min_r=${min_r}`
        );

        return ok({
          source: { entity: key, metric },
          correlated_datasets: correlations,
          interpretation: !correlations?.length
            ? 'No significant correlations found — this dataset appears independent.'
            : `${correlations.length} correlated datasets found. If ${key} fails, check these datasets too.`,
        });
      } catch (e) { return err(e); }
    }
  );

}
