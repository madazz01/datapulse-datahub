import fetch from 'node-fetch';

const DATAHUB_URL = process.env.DATAHUB_URL  || 'http://localhost:8080';
const STASIS_URL  = process.env.STASIS_URL   || 'http://localhost:3400';
const STASIS_KEY  = process.env.STASIS_KEY;   // required — get yours at intellistasis.com
const DH_AUTH     = process.env.DATAHUB_AUTH || 'Basic ZGF0YWh1YjpkYXRhaHVi'; // default: datahub:datahub

// Structured property URNs — namespaced under datapulse
const SP_SCORE   = 'urn:li:structuredProperty:datapulse.score';
const SP_STATUS  = 'urn:li:structuredProperty:datapulse.status';
const SP_CHECKED = 'urn:li:structuredProperty:datapulse.checked_at';

// ── DataHub GraphQL ───────────────────────────────────────────────────────────

async function gql(query) {
  const res = await fetch(`${DATAHUB_URL}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': DH_AUTH },
    body: JSON.stringify({ query })
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function getDatasets() {
  const data = await gql(`{
    search(input: { type: DATASET, query: "*", start: 0, count: 200 }) {
      searchResults {
        entity {
          urn
          ... on Dataset {
            name
            platform { name }
            lastIngested
            health { status type }
            schemaMetadata { fields { fieldPath } }
            ownership { owners { owner { ... on CorpUser { username } } } }
            deprecation { deprecated }
            glossaryTerms { terms { term { name } } }
          }
        }
      }
    }
  }`);
  return data.search.searchResults.map(r => r.entity).filter(e => e.name);
}

async function getDashboards() {
  const data = await gql(`{
    search(input: { type: DASHBOARD, query: "*", start: 0, count: 100 }) {
      searchResults {
        entity {
          urn
          ... on Dashboard {
            info { name lastRefreshed }
            platform { name }
          }
        }
      }
    }
  }`);
  return data.search.searchResults.map(r => r.entity).filter(e => e.info?.name);
}

async function getDataJobs() {
  const data = await gql(`{
    search(input: { type: DATA_JOB, query: "*", start: 0, count: 100 }) {
      searchResults {
        entity {
          urn
          ... on DataJob {
            info { name }
            dataFlow { platform { name } }
          }
        }
      }
    }
  }`);
  return data.search.searchResults.map(r => r.entity).filter(e => e.info?.name);
}

// ── Structured Properties setup ───────────────────────────────────────────────

async function gqlMutate(query, variables) {
  const res = await fetch(`${DATAHUB_URL}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': DH_AUTH },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data;
}

async function createStructuredProperty(id, displayName, description, valueType) {
  try {
    await gqlMutate(`
      mutation CreateStructuredProperty($input: CreateStructuredPropertyInput!) {
        createStructuredProperty(input: $input) { urn }
      }
    `, {
      input: {
        id,
        qualifiedName: id,
        displayName,
        description,
        valueType,
        cardinality: 'SINGLE',
        entityTypes: ['urn:li:entityType:datahub.dataset'],
      }
    });
    return true;
  } catch (e) {
    // "already exists" is fine — it means the property is already registered
    if (e.message.includes('already exists') || e.message.includes('conflict')) return true;
    console.warn(`  Structured property failed for ${id}: ${e.message.slice(0, 150)}`);
    return false;
  }
}

async function setupStructuredProperties() {
  console.log('Registering DataPulse structured properties...');
  const results = await Promise.all([
    createStructuredProperty(
      'datapulse.score',
      'DataPulse Score',
      'Composite health score 0–100. Calculated every 6 hours from: freshness (last ingestion time), incident status, and governance coverage (owner + glossary terms + schema). Score ≥80 = healthy, 55–79 = drifting, <55 = anomaly.',
      'urn:li:dataType:datahub.number'
    ),
    createStructuredProperty(
      'datapulse.status',
      'DataPulse Status',
      'Health status assigned by DataPulse. healthy = operating normally (score ≥80). drifting = degraded but not critical (score 55–79), typically means data is stale or governance is incomplete. anomaly = significant deviation detected (score <55). deprecated = asset is marked deprecated.',
      'urn:li:dataType:datahub.string'
    ),
    createStructuredProperty(
      'datapulse.checked_at',
      'DataPulse Last Checked',
      'Date when DataPulse last evaluated this dataset. DataPulse runs every 6 hours and re-scores all assets. If this date is more than 12 hours old, the DataPulse connector may not be running.',
      'urn:li:dataType:datahub.string'
    ),
  ]);
  const ok = results.filter(Boolean).length;
  console.log(`  ${ok}/3 structured properties registered`);
  return ok;
}

// ── DataPulse write-back ──────────────────────────────────────────────────────

function calcPulse(healthScore, hoursSince, govScore, deprecated) {
  if (deprecated) return { score: 0, status: 'deprecated' };

  let score = 0;
  score += healthScore === 1 ? 40 : 0;
  if (hoursSince !== null) {
    if (hoursSince < 24)       score += 35;
    else if (hoursSince < 48)  score += 25;
    else if (hoursSince < 96)  score += 10;
  } else {
    score += 20;
  }
  score += Math.round(govScore * 25);

  const status = score >= 80 ? 'healthy' : score >= 55 ? 'drifting' : 'anomaly';
  return { score, status };
}

async function writeStructuredPulse(urn, pulse) {
  const checked = new Date().toISOString().split('T')[0];
  try {
    await gqlMutate(`
      mutation UpsertStructuredProperties($input: UpsertStructuredPropertiesInput!) {
        upsertStructuredProperties(input: $input) {
          properties { structuredProperty { urn } }
        }
      }
    `, {
      input: {
        assetUrn: urn,
        structuredPropertyInputParams: [
          { structuredPropertyUrn: SP_SCORE,   values: [{ numberValue: pulse.score }] },
          { structuredPropertyUrn: SP_STATUS,  values: [{ stringValue: pulse.status }] },
          { structuredPropertyUrn: SP_CHECKED, values: [{ stringValue: checked }] },
        ]
      }
    });
    return true;
  } catch (e) {
    return false;
  }
}

// Keep custom properties as fallback — visible in Properties tab even if structured props fail
async function writeCustomPulse(urn, pulse) {
  const encoded = encodeURIComponent(urn);
  const checked = new Date().toISOString().split('T')[0];

  const res = await fetch(
    `${DATAHUB_URL}/openapi/v2/entity/dataset/${encoded}/datasetProperties`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json', 'Authorization': DH_AUTH },
      body: JSON.stringify({
        patch: [
          { op: 'add', path: '/customProperties/datapulse_score',   value: String(pulse.score) },
          { op: 'add', path: '/customProperties/datapulse_status',  value: pulse.status         },
          { op: 'add', path: '/customProperties/datapulse_checked', value: checked              },
        ],
        arrayPrimaryKeys: {}
      })
    }
  );
  return res.ok;
}

// ── Stasis signal bus ─────────────────────────────────────────────────────────

async function pushSignal(entity, metric, value, ts) {
  const body = { domain: 'datahub', entity: entity.substring(0, 50), metric, value, ts: ts || Date.now() };
  const res = await fetch(`${STASIS_URL}/api/signals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': STASIS_KEY },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    if (!text.includes('Duplicate')) console.error(`Signal failed ${entity}/${metric}: ${text}`);
  }
  return res.ok;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function entityKey(platform, name) {
  return `${platform}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  // Register structured property definitions (idempotent — safe to run every time)
  await setupStructuredProperties();

  const now = Date.now();
  let signals = 0, pulses = 0;

  // ── Datasets ────────────────────────────────────────────────────────────
  console.log('Pulling datasets...');
  const datasets = await getDatasets();
  console.log(`Found ${datasets.length} datasets`);

  for (const ds of datasets) {
    const key = entityKey(ds.platform?.name || 'unknown', ds.name);

    const incident    = ds.health?.find(h => h.type === 'INCIDENTS');
    const healthScore = incident?.status === 'PASS' ? 1 : 0;
    const fieldCount  = ds.schemaMetadata?.fields?.length || 0;
    const ownerCount  = ds.ownership?.owners?.length || 0;
    const termCount   = ds.glossaryTerms?.terms?.length || 0;
    const deprecated  = ds.deprecation?.deprecated ? 1 : 0;
    const govScore    = Math.round(Math.min(1,
      (ownerCount > 0 ? 0.5 : 0) + (termCount > 0 ? 0.3 : 0) + (fieldCount > 0 ? 0.2 : 0)
    ) * 100) / 100;

    let hoursSince = null;
    if (ds.lastIngested) {
      hoursSince = Math.round((now - ds.lastIngested) / 3600000 * 10) / 10;
      if (await pushSignal(key, 'hours_since_ingestion', hoursSince, now)) signals++;
    }

    if (await pushSignal(key, 'health_score',    healthScore, now)) signals++;
    if (fieldCount > 0 && await pushSignal(key, 'field_count', fieldCount, now)) signals++;
    if (await pushSignal(key, 'has_owner',        ownerCount > 0 ? 1 : 0, now)) signals++;
    if (await pushSignal(key, 'deprecated',       deprecated, now)) signals++;
    if (await pushSignal(key, 'governance_score', govScore, now)) signals++;

    const pulse = calcPulse(healthScore, hoursSince, govScore, deprecated);
    const spOk  = await writeStructuredPulse(ds.urn, pulse);
    const cpOk  = await writeCustomPulse(ds.urn, pulse);
    if (spOk || cpOk) pulses++;
  }

  // ── Dashboards ───────────────────────────────────────────────────────────
  console.log('Pulling dashboards...');
  try {
    const dashboards = await getDashboards();
    console.log(`Found ${dashboards.length} dashboards`);
    for (const dash of dashboards) {
      const key = entityKey(dash.platform?.name || 'dashboard', dash.info.name);
      if (dash.info.lastRefreshed) {
        const hrs = Math.round((now - dash.info.lastRefreshed) / 3600000 * 10) / 10;
        if (await pushSignal(key, 'hours_since_refresh', hrs, now)) signals++;
      }
    }
  } catch (e) { console.warn('Dashboard pull skipped:', e.message); }

  // ── Data Jobs ────────────────────────────────────────────────────────────
  console.log('Pulling data jobs...');
  try {
    const jobs = await getDataJobs();
    console.log(`Found ${jobs.length} data jobs`);
    for (const job of jobs) {
      const key = entityKey(job.dataFlow?.platform?.name || 'pipeline', job.info.name);
      if (await pushSignal(key, 'pipeline_active', 1, now)) signals++;
    }
  } catch (e) { console.warn('Data job pull skipped:', e.message); }

  console.log(`\nDone. Pushed ${signals} signals · Wrote ${pulses} pulse scores back to DataHub.`);
}

run().catch(console.error);
