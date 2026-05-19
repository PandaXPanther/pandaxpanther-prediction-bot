"""
Quant Service — Python sidecar for weather modeling.

Exposes HTTP endpoints that the TS bot calls to get model probabilities
for Kalshi weather contracts.

Endpoints:
    GET /health
    GET /weather/prob?station=KNYC&metric=high_temp_f&threshold=85&date=2026-05-20
        -> { prob: 0.62, ensemble_mean: 84.3, ensemble_std: 3.1 }
    GET /weather/refresh?station=KNYC
        -> Triggers a fresh NOAA pull and caches the forecast.

Data sources:
    - NOAA NDFD/NBM gridded forecasts via api.weather.gov
    - For full ensemble (HGEFS), we use the NOAA NOMADS THREDDS server
      (see fetch_hgefs.py — V2 enhancement)

V1 uses NBM (National Blend of Models) which gives point forecasts + uncertainty
bands. This is the "good enough" approximation; HGEFS gives more accurate
distribution tails but requires significantly more bandwidth/compute.

Run:
    uvicorn main:app --host 0.0.0.0 --port 8000
"""

from datetime import date, datetime, timedelta
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel
from scipy.stats import norm

app = FastAPI(title="PandaXPanther Quant Service")

# Station to NOAA grid mapping (lat/lon for 'points' endpoint)
STATIONS = {
    "KNYC": (40.7128, -74.0060, "New York"),
    "KLAX": (34.0522, -118.2437, "Los Angeles"),
    "KORD": (41.8781, -87.6298, "Chicago"),
    "KMIA": (25.7617, -80.1918, "Miami"),
    "KDEN": (39.7392, -104.9903, "Denver"),
    "KSEA": (47.6062, -122.3321, "Seattle"),
    "KATL": (33.7490, -84.3880, "Atlanta"),
    "KBOS": (42.3601, -71.0589, "Boston"),
    "KHOU": (29.7604, -95.3698, "Houston"),
    "KPHX": (33.4484, -112.0740, "Phoenix"),
}

# In-memory cache of recent forecasts: { (station, date): forecast_data }
_forecast_cache: dict[tuple[str, str], dict] = {}
_cache_ts: dict[tuple[str, str], datetime] = {}
CACHE_TTL_MINUTES = 60


class ProbResponse(BaseModel):
    station: str
    metric: str
    target_date: str
    threshold: float
    direction: str
    prob: float
    ensemble_mean: float
    ensemble_std: float
    forecast_ts: str
    model: str
    source_data_points: int


@app.get("/health")
def health():
    return {"status": "ok", "stations": list(STATIONS.keys())}


async def fetch_nbm_forecast(station: str) -> dict:
    """Fetch NBM grid forecast for a station via api.weather.gov."""
    if station not in STATIONS:
        raise HTTPException(404, f"Unknown station {station}")

    cache_key = (station, "current")
    if (
        cache_key in _forecast_cache
        and _cache_ts.get(cache_key)
        and (datetime.utcnow() - _cache_ts[cache_key]).total_seconds() < CACHE_TTL_MINUTES * 60
    ):
        return _forecast_cache[cache_key]

    lat, lon, _ = STATIONS[station]
    async with httpx.AsyncClient(timeout=20.0) as client:
        # Step 1: resolve grid
        points_url = f"https://api.weather.gov/points/{lat},{lon}"
        r = await client.get(points_url, headers={"User-Agent": "pandaxpanther-bot/0.1"})
        r.raise_for_status()
        points_data = r.json()
        forecast_url = points_data["properties"]["forecastGridData"]

        # Step 2: pull the grid (hourly+daily forecasts)
        r2 = await client.get(forecast_url, headers={"User-Agent": "pandaxpanther-bot/0.1"})
        r2.raise_for_status()
        grid_data = r2.json()

    _forecast_cache[cache_key] = grid_data
    _cache_ts[cache_key] = datetime.utcnow()
    return grid_data


def extract_metric_values(grid_data: dict, metric: str, target_date: date) -> list[float]:
    """Extract daily values for a metric from the NBM grid response."""
    props = grid_data.get("properties", {})

    # NWS uses different property keys per metric
    METRIC_MAP = {
        "high_temp_f": "maxTemperature",
        "low_temp_f": "minTemperature",
        "precip_in": "quantitativePrecipitation",
    }
    key = METRIC_MAP.get(metric)
    if not key:
        raise HTTPException(400, f"Unsupported metric {metric}")

    values = props.get(key, {}).get("values", [])
    matched: list[float] = []
    for v in values:
        valid_time = v.get("validTime", "")
        # validTime format: "2026-05-19T12:00:00+00:00/PT6H"
        try:
            start_str = valid_time.split("/")[0]
            start = datetime.fromisoformat(start_str.replace("Z", "+00:00"))
            if start.date() == target_date:
                val = v.get("value")
                if val is not None:
                    # NWS returns temps in C; convert to F if metric ends with _f
                    if metric.endswith("_f"):
                        val = (val * 9 / 5) + 32
                    elif metric == "precip_in":
                        # NWS returns mm; convert to inches
                        val = val / 25.4
                    matched.append(val)
        except (ValueError, KeyError):
            continue

    return matched


@app.get("/weather/prob", response_model=ProbResponse)
async def weather_prob(
    station: str = Query(..., description="Station code, e.g. KNYC"),
    metric: str = Query("high_temp_f", description="high_temp_f | low_temp_f | precip_in"),
    threshold: float = Query(..., description="Numeric threshold to compare against"),
    direction: str = Query("above", description="above | below"),
    target_date: Optional[str] = Query(None, description="YYYY-MM-DD; defaults to tomorrow"),
):
    """
    Compute the probability that <metric> at <station> on <target_date> will be
    <direction> <threshold>.

    Uses NBM-derived ensemble approximation (mean + uncertainty band).
    """
    if target_date:
        td = date.fromisoformat(target_date)
    else:
        td = date.today() + timedelta(days=1)

    grid = await fetch_nbm_forecast(station)
    samples = extract_metric_values(grid, metric, td)
    if not samples:
        raise HTTPException(404, f"No forecast data for {station}/{metric} on {td}")

    # Estimate distribution from intra-day samples
    import numpy as np
    arr = np.array(samples)
    # Daily aggregation per metric
    if metric == "high_temp_f":
        point_estimate = float(arr.max())
    elif metric == "low_temp_f":
        point_estimate = float(arr.min())
    else:
        point_estimate = float(arr.sum())

    # Forecast standard deviation — empirically calibrated.
    # NBM's RMSE for next-day high temp is ~3.0°F at most stations.
    # For precip, RMSE is ~0.15 inch on rainy days.
    # We use these as ~σ for a normal-approximation tail probability.
    sigma_map = {
        "high_temp_f": 3.0,
        "low_temp_f": 2.5,
        "precip_in": 0.20,
    }
    sigma = sigma_map.get(metric, 1.0)

    # Inflate sigma based on days-ahead
    days_out = (td - date.today()).days
    sigma *= 1 + 0.25 * max(0, days_out - 1)

    z = (threshold - point_estimate) / sigma
    if direction == "above":
        prob = 1.0 - norm.cdf(z)
    else:
        prob = norm.cdf(z)

    return ProbResponse(
        station=station,
        metric=metric,
        target_date=td.isoformat(),
        threshold=threshold,
        direction=direction,
        prob=round(prob, 5),
        ensemble_mean=round(point_estimate, 2),
        ensemble_std=round(sigma, 2),
        forecast_ts=datetime.utcnow().isoformat(),
        model="nbm_v4_approx",
        source_data_points=len(samples),
    )


@app.get("/weather/refresh")
async def refresh(station: str):
    """Force-refresh a station's forecast (bypasses cache)."""
    _forecast_cache.pop((station, "current"), None)
    _cache_ts.pop((station, "current"), None)
    grid = await fetch_nbm_forecast(station)
    return {"refreshed": station, "updated_at": datetime.utcnow().isoformat()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
