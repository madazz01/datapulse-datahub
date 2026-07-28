# DataPulse for DataHub

**Continuous intelligence monitoring for your DataHub data catalog.**

DataPulse connects DataHub to the [Intelli-Stasis](https://intellistasis.com) intelligence engine. Every 6 hours it pulls metadata signals from your DataHub instance, runs them through structural break detection, correlation analysis, and cycle tracking, then writes a **DataPulse score** back to each dataset as a structured property — visible directly in the DataHub UI.

Built for the [DataHub Agent Hackathon 2026](https://datahub.io).

---

## What it does

### Connector (`connector.js`)
Pulls signals from DataHub and pushes them into the Intelli-Stasis signal bus:

| Signal | Source |
|--------|--------|
| `hours_since_ingestion` | `lastIngested` timestamp |
| `health_score` | Incident health check (PASS = 1, FAIL = 0) |
| `field_count` | Schema field count |
| `has_owner` | Ownership coverage (1/0) |
| `governance_score` | Composite: owner + glossary terms + schema |
| `deprecated` | Deprecation flag |

The engine then runs CUSUM structural break detection and Pearson cross-correlation across all signals — finding which datasets move together and when something genuinely shifts vs. just spikes.

### DataPulse Score
After processing, a composite score (0–100) is written back to each dataset as a DataHub **structured property**:

| Property | Description |
|----------|-------------|
| `DataPulse Score` | 0–100 composite health score |
| `DataPulse Status` | `healthy` (≥80) · `drifting` (55–79) · `anomaly` (<55) · `deprecated` |
| `DataPulse Last Checked` | Date of last evaluation |

Scores appear in a dedicated **datapulse** section on every dataset page in the DataHub UI.

### MCP Tools (`mcp/datahub.js`)
Four MCP tools for AI agents to query DataHub intelligence:

| Tool | Use |
|------|-----|
| `datahub_dataset_intelligence` | Full signal history + breaks + correlations for one dataset |
| `datahub_health_overview` | Stack-wide structural breaks and affected entities |
| `datahub_anomaly_alerts` | Datasets in structural break, ranked by severity |
| `datahub_correlation_graph` | Blast-radius analysis — what breaks if this dataset fails |

---

## Setup

### Prerequisites
- DataHub instance (tested on v1.5.0.6)
- [Intelli-Stasis](https://intellistasis.com) API key (free tier available)
- Node.js 18+

### 1. Install
```bash
git clone https://github.com/madazz01/datapulse-datahub.git
cd datapulse-datahub
npm install node-fetch
```

### 2. Configure
Set environment variables (or edit the constants at the top of `connector.js`):

```bash
export DATAHUB_URL=http://localhost:8080        # your DataHub GMS URL
export STASIS_URL=https://api.intellistasis.com # Intelli-Stasis API
export STASIS_KEY=sk_stasis_demo_46a9fb14a7d23d260137f2ad4f0b8708  # demo key (100 calls/day)
```

> **Demo key** `sk_stasis_demo_46a9fb14a7d23d260137f2ad4f0b8708` — free tier, 100 calls/day, points at the live Intelli-Stasis engine. Get your own key at [intellistasis.com](https://intellistasis.com) for unlimited access.

### 3. Run
```bash
node connector.js
```

On first run it registers the DataPulse structured property definitions in DataHub, then pulls all datasets, dashboards, and data jobs. Subsequent runs are additive — the engine builds a historical signal record over time.

### 4. Schedule (optional)
Run every 6 hours with PM2:
```bash
pm2 start connector.js --name datahub-connector --cron "0 */6 * * *"
```

---

## MCP Integration

Add the DataHub tools to your MCP server by importing `mcp/datahub.js`:

```js
import { registerDataHubTools } from './mcp/datahub.js';
registerDataHubTools(mcp);
```

The tools call the Intelli-Stasis API — set `STASIS_CORE_URL` in your environment or update the import in `mcp/datahub.js`.

---

## How the scoring works

```
DataPulse Score = freshness + health + governance

Freshness  (max 35):  <24h → 35pts · <48h → 25pts · <96h → 10pts
Health     (max 40):  incident PASS → 40pts
Governance (max 25):  owner(0.5) + glossary terms(0.3) + schema(0.2) × 25

≥80 = healthy · 55–79 = drifting · <55 = anomaly · deprecated = 0
```

The score is a starting point. The real value comes from the engine watching scores over time — detecting when a dataset that was always healthy starts drifting, and which other datasets correlate with the shift.

---

## Pre-existing components disclosed

Per hackathon rules: the Intelli-Stasis intelligence engine (structural break detection, correlation analysis, calibration) is pre-existing proprietary infrastructure. The DataHub connector, structured property write-back, and MCP tools in this repo were built specifically for this hackathon.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).

## Author

Bryan Horsfield · [Intelli-Stasis](https://intellistasis.com)
