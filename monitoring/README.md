# REVIEW: Demos Network Monitoring Stack

Prometheus + Grafana monitoring solution for Demos Network nodes with full Demos branding.

## Quick Start

```bash
cd monitoring
echo "GRAFANA_ADMIN_PASSWORD=<a strong password>" >> .env   # required; "demos" is refused
docker compose up -d
```

**Access Grafana**: http://localhost:3000
**Credentials**: `admin` / the `GRAFANA_ADMIN_PASSWORD` set in `monitoring/.env`

`up` also needs the three Alertmanager webhook files (`slack_webhook`, `pager_webhook`,
`deadman_webhook`) in `monitoring/secrets/`; create them first as described in
[`secrets/README.md`](secrets/README.md).

## Prerequisites

- Docker and Docker Compose v2+
- Demos node running with metrics enabled
- At least 512MB RAM available for monitoring stack

## Architecture

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   Demos Node    │──────│   Prometheus    │──────│    Grafana      │
│  :9090/metrics  │      │     :9091       │      │     :3000       │
└─────────────────┘      └─────────────────┘      └─────────────────┘
                              (scrapes)            (visualizes)
```

## Enabling Metrics on Your Node

Add to your `.env` file:

```env
METRICS_ENABLED=true
METRICS_PORT=9090
```

The node will expose metrics at `http://localhost:9090/metrics`.

## Configuration

### Environment Variables

**Important Port Distinction:**

- `METRICS_PORT` (default `9090`): Configured in the **main project `.env`** file - this is the port where your Demos node exposes its metrics
- `PROMETHEUS_PORT` (default `9091`): Configured in `monitoring/.env` - this is the Prometheus server's external port

If you change `METRICS_PORT` in your main `.env` file, you must also update the scrape target in `prometheus/prometheus.yml` to match.

Create a `.env` file in the monitoring directory or export these variables:

| Variable                 | Default                 | Description                                                  |
| ------------------------ | ----------------------- | ------------------------------------------------------------ |
| `PROMETHEUS_PORT`        | `9091`                  | Prometheus server external port (not the node metrics port!) |
| `PROMETHEUS_RETENTION`   | `15d`                   | Data retention period                                        |
| `GRAFANA_PORT`           | `3000`                  | Grafana external port                                        |
| `GRAFANA_ADMIN_USER`     | `admin`                 | Grafana admin username                                       |
| `GRAFANA_ADMIN_PASSWORD` | _(required)_            | Grafana admin password; compose refuses to start without it, or with `demos` |
| `GRAFANA_ROOT_URL`       | `http://localhost:3000` | Public Grafana URL                                           |
| `NODE_EXPORTER_PORT`     | `9100`                  | Node Exporter port (full profile)                            |
| `MONITORING_BIND`        | `127.0.0.1`             | Host interface for the Prometheus, Grafana and Node Exporter ports; never `0.0.0.0` |

### Example `.env` file

```env
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=your-secure-password
GRAFANA_PORT=3000
PROMETHEUS_PORT=9091
PROMETHEUS_RETENTION=30d
```

## Services

### Prometheus (port 9091)

- Scrapes metrics from Demos node every 5 seconds
- Stores time-series data for 15 days by default
- Web console available at http://localhost:9091

### Grafana (port 3000)

- Visualization and dashboards
- Pre-configured Prometheus datasource
- Demos Network branded interface
- Two pre-built dashboards included

### Node Exporter (optional)

Host-level metrics for deeper system insights:

```bash
docker compose --profile full up -d
```

## Dashboards

### Demos Network - Node Overview

The main dashboard showing:

- **Block Height**: Current chain height
- **Seconds Since Last Block**: Block production latency
- **Online Peers**: Connected peer count
- **TX in Last Block**: Transaction throughput
- **System Resources**: CPU and memory usage
- **Load Average**: System load (1m, 5m, 15m)
- **Docker Container Status**: PostgreSQL, TLSN, IPFS
- **Port Status**: Critical service ports
- **Network I/O Rate**: Bandwidth usage

### System Health

Detailed system metrics:

- CPU usage by type (user, system, idle)
- Memory breakdown (used, available, cached)
- Disk I/O rates
- Network interface statistics

## Metrics Reference

### Blockchain Metrics

| Metric                           | Type  | Description                |
| -------------------------------- | ----- | -------------------------- |
| `demos_block_height`             | Gauge | Current block height       |
| `demos_seconds_since_last_block` | Gauge | Time since last block      |
| `demos_last_block_tx_count`      | Gauge | Transactions in last block |
| `demos_peer_online_count`        | Gauge | Online peer count          |
| `demos_peer_total_count`         | Gauge | Total known peers          |

### System Metrics

| Metric                               | Type  | Description            |
| ------------------------------------ | ----- | ---------------------- |
| `demos_system_cpu_usage_percent`     | Gauge | CPU utilization        |
| `demos_system_memory_usage_percent`  | Gauge | Memory utilization     |
| `demos_system_memory_used_bytes`     | Gauge | Memory used in bytes   |
| `demos_system_load_average_1m`       | Gauge | 1-minute load average  |
| `demos_system_load_average_5m`       | Gauge | 5-minute load average  |
| `demos_system_load_average_15m`      | Gauge | 15-minute load average |
| `demos_system_network_rx_rate_bytes` | Gauge | Network receive rate   |
| `demos_system_network_tx_rate_bytes` | Gauge | Network transmit rate  |

### Service Metrics

| Metric                              | Type  | Description              |
| ----------------------------------- | ----- | ------------------------ |
| `demos_service_docker_container_up` | Gauge | Container status (0/1)   |
| `demos_service_port_open`           | Gauge | Port accessibility (0/1) |

## Commands

Run these from `monitoring/` (the `cd monitoring` from Quick Start).

```bash
# Start the stack
docker compose up -d

# Start with host metrics (node exporter)
docker compose --profile full up -d

# View logs
docker compose logs -f

# View specific service logs
docker compose logs -f grafana
docker compose logs -f prometheus

# Restart services
docker compose restart

# Stop the stack
docker compose down

# Stop and remove volumes (data loss!)
docker compose down -v
```

## Advanced Usage

### Custom Prometheus Targets

Edit `prometheus/prometheus.yml` to add additional scrape targets:

```yaml
scrape_configs:
    - job_name: "my-custom-target"
      static_configs:
          - targets: ["host.docker.internal:8080"]
```

### Alert rules and routing

Rules are in `prometheus/alerts/`, routing in `alertmanager/alertmanager.yml`. What each
alert means and what to do is in [`docs/runbooks/mainnet-monitoring.md`](../docs/runbooks/mainnet-monitoring.md).
Critical and page alerts go to both Slack and paging, warning and info to Slack only (except `MissedSignatures`, which notifies nobody), the
dead-man heartbeat to its own receiver only. `BlockHashMismatch`, `ConflictingBlock`,
`ForeignSignature` and `PrecommitEquivocation` are latched for 7 days and do not resolve by
themselves; the clear procedure is in the runbook ("Clearing a latched alert").
Unit tests for the rules are in `prometheus/tests/`. Check rules, config and routing with
`./scripts/check-monitoring.sh` from the repository root (needs `promtool` and `amtool` on PATH).

### Creating Custom Dashboards

1. Log into Grafana
2. Create a new dashboard
3. Add panels using `demos_*` metrics
4. Export as JSON (Share > Export > Save to file)
5. Save to `grafana/provisioning/dashboards/json/`

## Troubleshooting

### Grafana shows "No Data"

1. Check if node metrics are enabled:

    ```bash
    curl http://localhost:9090/metrics
    ```

2. Verify Prometheus can reach the node:

    ```bash
    docker compose logs prometheus | grep -i error
    ```

3. Check Prometheus targets: http://localhost:9091/targets

### Cannot access Grafana

1. Check if containers are running:

    ```bash
    docker compose ps
    ```

2. Check for port conflicts:
    ```bash
    lsof -i :3000
    ```

### High memory usage

Reduce Prometheus retention:

```env
PROMETHEUS_RETENTION=7d
```

### Docker networking issues

On Linux, the `host.docker.internal` alias should work. If not:

- Check that `extra_hosts` is configured in docker-compose.yml
- Alternatively, use the host network mode for Prometheus

## Directory Structure

```
monitoring/
├── docker-compose.yml          # Main stack configuration
├── README.md                   # This file
├── prometheus/
│   ├── prometheus.yml          # Prometheus scrape configuration
│   ├── alerts/                 # Alert rules (loaded by alerts/*.yml)
│   └── tests/                  # promtool unit tests for the alert rules
├── alertmanager/
│   └── alertmanager.yml        # Routing: Slack, paging, dead-man receivers
└── grafana/
    ├── grafana.ini             # Grafana settings
    ├── branding/               # Custom logos and assets
    │   ├── demos-logo-morph.svg
    │   ├── demos-logo-white.svg
    │   ├── favicon.png
    │   └── logo.jpg
    └── provisioning/
        ├── datasources/
        │   └── prometheus.yml  # Prometheus datasource config
        └── dashboards/
            ├── dashboards.yml  # Dashboard provider config
            └── json/
                ├── demos-overview.json
                └── system-health.json
```

## Security Notes

- **Change default credentials** for production deployments
- Consider **not exposing Prometheus** port externally (remove port mapping)
- Use **HTTPS/TLS** for production Grafana
- **Restrict network access** to monitoring services
- Consider using **Grafana's built-in auth** or external OAuth

## Contributing

When adding new metrics:

1. Add the metric to `src/features/metrics/MetricsCollector.ts`
2. Update Prometheus configuration if needed
3. Create or update dashboards in `grafana/provisioning/dashboards/json/`
4. Update this README with metric documentation

---

**Demos Network** - https://demos.sh
