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

# ============================================================================
# Shared HTTP client
# ============================================================================
_http_client = httpx.AsyncClient(
    timeout=20.0,
    headers={"User-Agent": "pandaxpanther-bot/0.1 (contact: pandaxpanther@gmail.com)"},
)


@app.on_event("shutdown")
async def shutdown():
    await _http_client.aclose()

# Station to NOAA grid mapping - EXPANDED 30 US cities
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
    "KDFW": (32.8998, -97.0403, "Dallas"),
    "KPHL": (39.9526, -75.1652, "Philadelphia"),
    "KSFO": (37.7749, -122.4194, "San Francisco"),
    "KDCA": (38.9072, -77.0369, "Washington DC"),
    "KMSP": (44.9778, -93.2650, "Minneapolis"),
    "KDTW": (42.3314, -83.0458, "Detroit"),
    "KMCO": (28.5383, -81.3792, "Orlando"),
    "KTPA": (27.9506, -82.4572, "Tampa"),
    "KLAS": (36.1699, -115.1398, "Las Vegas"),
    "KAUS": (30.2672, -97.7431, "Austin"),
    "KSAN": (32.7157, -117.1611, "San Diego"),
    "KPDX": (45.5152, -122.6784, "Portland"),
    "KBWI": (39.2904, -76.6122, "Baltimore"),
    "KCLT": (35.2271, -80.8431, "Charlotte"),
    "KBNA": (36.1627, -86.7816, "Nashville"),
    "KSTL": (38.6270, -90.1994, "Saint Louis"),
    "KCLE": (41.4993, -81.6944, "Cleveland"),
    "KPIT": (40.4406, -79.9959, "Pittsburgh"),
    "KSLC": (40.7608, -111.8910, "Salt Lake City"),
    "KIND": (39.7684, -86.1581, "Indianapolis"),
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


@app.get("/")
def root():
    return {
        "service": "pandaxpanther-quant",
        "status": "ok",
        "endpoints": [
            "/health",
            "/weather/prob?station=KNYC&metric=high_temp_f&threshold=85&direction=above",
            "/macro/gdp-prob?threshold=3.0&direction=above",
            "/macro/cpi-prob?threshold=3.0&direction=above",
            "/sports/games?league=nba",
            "/sports/win-prob?league=nba&event_id=401873341",
        ],
    }


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


@app.get("/weather/refresh-all")
async def refresh_all_weather():
    """Force-refresh forecasts for every known station (bypasses cache)."""
    _forecast_cache.clear()
    _cache_ts.clear()
    results = {}
    for st in STATIONS.keys():
        try:
            await fetch_nbm_forecast(st)
            results[st] = "ok"
        except Exception as e:
            results[st] = f"error: {str(e)[:100]}"
    return {"refreshed": len(results), "stations": results, "updated_at": datetime.utcnow().isoformat()}


@app.post("/macro/refresh")
@app.get("/macro/refresh")
async def refresh_macro():
    """Manually force-refresh all FRED macro series (GDPNow, CPI, etc.).

    Useful when a new econ release just dropped — bypasses 30min TTL.
    """
    _macro_cache.clear()
    _macro_ts.clear()
    series_pulled = []
    for s in ["GDPNOW", "CPIAUCSL", "PCEPI", "UNRATE", "PAYEMS", "DFF"]:
        try:
            rows = await _fred_csv(s)
            series_pulled.append({"series": s, "rows": len(rows), "latest": rows[-1] if rows else None})
        except Exception as e:
            series_pulled.append({"series": s, "error": str(e)[:200]})
    return {
        "refreshed_at": datetime.utcnow().isoformat(),
        "series": series_pulled,
    }


@app.post("/refresh-all")
@app.get("/refresh-all")
async def refresh_everything():
    """Refresh weather + macro caches in one shot."""
    weather = await refresh_all_weather()
    macro = await refresh_macro()
    return {"weather": weather, "macro": macro}


# ============================================================================
# ECONOMIC NOWCAST ENDPOINTS
# ============================================================================

_macro_cache: dict[str, dict] = {}
_macro_ts: dict[str, datetime] = {}
MACRO_TTL_MINUTES = 30  # macro data updates daily at most


async def _fred_csv(series_id: str) -> list[tuple[str, float]]:
    """Fetch a FRED series as CSV. Free, no API key required.

    Returns: list of (date_str, value) tuples in chronological order.
    """
    cache_key = f"fred:{series_id}"
    if cache_key in _macro_cache and (datetime.utcnow() - _macro_ts.get(cache_key, datetime.min)).total_seconds() < MACRO_TTL_MINUTES * 60:
        return _macro_cache[cache_key]["rows"]

    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    r = await _http_client.get(url)
    r.raise_for_status()
    rows = []
    for line in r.text.strip().split("\n")[1:]:  # skip header
        parts = line.split(",")
        if len(parts) >= 2 and parts[1] not in (".", ""):
            try:
                rows.append((parts[0], float(parts[1])))
            except ValueError:
                continue
    _macro_cache[cache_key] = {"rows": rows}
    _macro_ts[cache_key] = datetime.utcnow()
    return rows


class MacroProbResponse(BaseModel):
    series: str
    metric: str
    threshold: float
    direction: str
    prob: float
    model_estimate: float
    model_std: float
    confidence: str  # 'high' | 'medium' | 'low'
    sources: list[str]
    notes: str


@app.get("/macro/cpi-prob", response_model=MacroProbResponse)
async def cpi_prob(
    threshold: float = Query(..., description="YoY CPI % threshold"),
    direction: str = Query("above", description="above | below"),
):
    """Probability that the next CPI YoY print will be above/below threshold.

    Simplified model:
    - Pull trailing 6 months of CPI YoY changes (CPIAUCSL)
    - Compute trend + noise band
    - Probability that next print is above threshold given current trajectory
    """
    rows = await _fred_csv("CPIAUCSL")
    if len(rows) < 13:
        raise HTTPException(503, "Insufficient CPI history")

    # Compute trailing YoY changes
    yoy_changes = []
    for i in range(len(rows) - 1, max(11, len(rows) - 13), -1):
        cur = rows[i][1]
        yr_ago = rows[i - 12][1] if i >= 12 else None
        if yr_ago:
            yoy_changes.append((rows[i][0], (cur / yr_ago - 1) * 100))
    if not yoy_changes:
        raise HTTPException(503, "Cannot compute YoY")
    yoy_changes.reverse()  # chronological

    # Simple persistence model: next YoY ~ last YoY + trend in last 3 months
    last_yoy = yoy_changes[-1][1]
    if len(yoy_changes) >= 3:
        trend_3mo = (yoy_changes[-1][1] - yoy_changes[-3][1]) / 2  # per-month avg change
    else:
        trend_3mo = 0

    model_estimate = last_yoy + trend_3mo
    # Empirical YoY CPI 1-month standard deviation is around 0.15-0.25 pp
    model_std = 0.20

    z = (threshold - model_estimate) / model_std
    prob = 1 - norm.cdf(z) if direction == "above" else norm.cdf(z)

    return MacroProbResponse(
        series="CPIAUCSL",
        metric="cpi_yoy_pct",
        threshold=threshold,
        direction=direction,
        prob=round(prob, 5),
        model_estimate=round(model_estimate, 3),
        model_std=round(model_std, 3),
        confidence="medium",  # No real nowcaster wired, just persistence
        sources=["FRED:CPIAUCSL"],
        notes="V2-lite model: persistence with 3-month trend. Cleveland Fed nowcaster not yet wired.",
    )


@app.get("/macro/gdp-prob", response_model=MacroProbResponse)
async def gdp_prob(
    threshold: float = Query(..., description="Annualized GDP growth % threshold"),
    direction: str = Query("above", description="above | below"),
):
    """Probability that next BEA GDP advance estimate will be above/below threshold,
    using Atlanta Fed GDPNow as the model.
    """
    rows = await _fred_csv("GDPNOW")
    if not rows:
        raise HTTPException(503, "No GDPNow data")
    latest_date, latest_value = rows[-1]

    # GDPNow forecast error std vs actual is documented as ~0.6 pp
    # (Bognanni & Hotchkiss, FRBA WP 2014-7)
    model_std = 0.60
    z = (threshold - latest_value) / model_std
    prob = 1 - norm.cdf(z) if direction == "above" else norm.cdf(z)

    return MacroProbResponse(
        series="GDPNOW",
        metric="gdp_annualized_pct",
        threshold=threshold,
        direction=direction,
        prob=round(prob, 5),
        model_estimate=round(latest_value, 3),
        model_std=model_std,
        confidence="high",  # GDPNow is genuinely good
        sources=[f"FRED:GDPNOW (latest: {latest_date})"],
        notes="Atlanta Fed GDPNow nowcast via FRED. Updated 2-3x per week.",
    )


# ============================================================================
# SPORTS ENDPOINTS — ESPN integration
# ============================================================================

_espn_cache: dict[tuple, dict] = {}
_espn_ts: dict[tuple, datetime] = {}
ESPN_TTL_SECONDS = 60  # ESPN updates win prob every few seconds during games

ESPN_BASE = "http://site.api.espn.com/apis/site/v2/sports"
LEAGUE_PATHS = {
    "nba": "basketball/nba",
    "wnba": "basketball/wnba",
    "mlb": "baseball/mlb",
    "nfl": "football/nfl",
    "nhl": "hockey/nhl",
}


class GameProbResponse(BaseModel):
    league: str
    event_id: str
    home_team: str
    away_team: str
    home_score: int
    away_score: int
    home_win_prob: float
    confidence: str
    state: str  # 'pre' | 'in' | 'post'
    sources: list[str]


@app.get("/sports/games")
async def list_games(league: str = Query(..., description="nba|wnba|mlb|nfl|nhl")):
    """List all games today for a league with current state."""
    if league not in LEAGUE_PATHS:
        raise HTTPException(400, f"Unsupported league {league}")
    url = f"{ESPN_BASE}/{LEAGUE_PATHS[league]}/scoreboard"
    r = await _http_client.get(url)
    r.raise_for_status()
    data = r.json()
    out = []
    for ev in data.get("events", []):
        comp = (ev.get("competitions") or [{}])[0]
        teams = comp.get("competitors", [])
        home = next((t for t in teams if t.get("homeAway") == "home"), None)
        away = next((t for t in teams if t.get("homeAway") == "away"), None)
        if not home or not away:
            continue
        out.append({
            "event_id": ev.get("id"),
            "name": ev.get("name"),
            "state": ev.get("status", {}).get("type", {}).get("state"),  # pre|in|post
            "detail": ev.get("status", {}).get("type", {}).get("detail"),
            "home": home.get("team", {}).get("abbreviation"),
            "away": away.get("team", {}).get("abbreviation"),
            "home_score": int(home.get("score") or 0),
            "away_score": int(away.get("score") or 0),
        })
    return {"league": league, "games": out}


@app.get("/sports/win-prob", response_model=GameProbResponse)
async def win_prob(
    league: str = Query(...),
    event_id: str = Query(...),
):
    """Get current home-team win probability for a specific game.

    Pre-game: uses ESPN's "Matchup Predictor" model.
    In-game: uses ESPN's live winprobability stream (updates every play).
    Post-game: returns 1.0 or 0.0 (resolved).
    """
    if league not in LEAGUE_PATHS:
        raise HTTPException(400, f"Unsupported league {league}")

    cache_key = (league, event_id)
    if cache_key in _espn_cache and (datetime.utcnow() - _espn_ts.get(cache_key, datetime.min)).total_seconds() < ESPN_TTL_SECONDS:
        return _espn_cache[cache_key]

    url = f"{ESPN_BASE}/{LEAGUE_PATHS[league]}/summary?event={event_id}"
    r = await _http_client.get(url)
    r.raise_for_status()
    summary = r.json()

    header = summary.get("header", {})
    competitions = header.get("competitions", [{}])
    comp = competitions[0] if competitions else {}
    teams = comp.get("competitors", [])
    home = next((t for t in teams if t.get("homeAway") == "home"), {})
    away = next((t for t in teams if t.get("homeAway") == "away"), {})
    state = comp.get("status", {}).get("type", {}).get("state", "pre")

    home_score = int(home.get("score") or 0)
    away_score = int(away.get("score") or 0)

    # Pre-game: matchup predictor
    win_prob_pct = 50.0
    confidence = "medium"
    if state == "pre":
        predictor = summary.get("predictor", {})
        home_pred = predictor.get("homeTeam", {}).get("gameProjection")
        if home_pred:
            win_prob_pct = float(home_pred)
            confidence = "medium"  # ESPN matchup predictor is reasonable but not great
    elif state == "in":
        # Live winprobability is an array; last entry = most recent play
        wp_arr = summary.get("winprobability", [])
        if wp_arr:
            last = wp_arr[-1]
            win_prob_pct = float(last.get("homeWinPercentage", 0.5)) * 100
            confidence = "high"  # In-game ESPN WP is quite good
    elif state == "post":
        win_prob_pct = 100.0 if home_score > away_score else 0.0
        confidence = "resolved"

    resp = GameProbResponse(
        league=league,
        event_id=event_id,
        home_team=home.get("team", {}).get("abbreviation", "?"),
        away_team=away.get("team", {}).get("abbreviation", "?"),
        home_score=home_score,
        away_score=away_score,
        home_win_prob=round(win_prob_pct / 100, 5),
        confidence=confidence,
        state=state,
        sources=[f"ESPN:{league}/summary?event={event_id}"],
    )
    _espn_cache[cache_key] = resp.dict()
    _espn_ts[cache_key] = datetime.utcnow()
    return resp


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
