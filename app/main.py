from __future__ import annotations

import asyncio
import json
import os
import re
import httpx
from enum import Enum
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
from typing import Annotated

from pathlib import Path
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from app.cache import cache
from app.models import SearchResponse, Product
from app.scrapers import amazon, flipkart

MAX_ALL_PAGES = 20
ALL_PAGES_DELAY = 1.0

app = FastAPI(
    title="PriceScout API",
    description=(
        "## Live product search API for Amazon India & Flipkart\n\n"
        "Scrapes real-time product data including prices, ratings, images, "
        "specs, and available filters. Supports search, filtering, sorting, "
        "pagination, and **automatic full-catalog fetching** (`all_pages=true`).\n\n"
        "### Key features\n"
        "- **Unified search** across both sites in parallel\n"
        "- **Per-site endpoints** for advanced, source-specific filtering\n"
        "- **Auto-pagination** — fetch every page of results in one call\n"
        "- **In-memory TTL cache** (5 min) to avoid redundant requests\n"
        "- **Dynamic filters** — each response includes available filters "
        "for the current query, ready to pass back as params\n\n"
        "### Rate limiting\n"
        "Both Amazon and Flipkart have anti-bot protections. "
        "This API adds a 1-second delay between pages during `all_pages` fetching. "
        "Avoid hammering the endpoints with many concurrent requests.\n"
    ),
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class Source(str, Enum):
    amazon = "amazon"
    flipkart = "flipkart"
    all = "all"


def _has_filters(**kwargs) -> bool:
    return any(v is not None for v in kwargs.values())


def _cache_key(source: str, **kwargs) -> tuple[str, ...]:
    parts = [source]
    for k in sorted(kwargs):
        v = kwargs[k]
        if v is not None:
            parts.append(f"{k}={v}")
    return tuple(parts)


async def _fetch_all_pages_amazon(
    q: str, sort: str | None,
    min_price: int | None, max_price: int | None,
    brand: str | None, rh: str | None,
    max_pages: int = 20,
) -> SearchResponse:
    first = await amazon.search(
        q, page=1, sort=sort,
        min_price=min_price, max_price=max_price,
        brand=brand, rh=rh,
    )
    seen_ids = {p.id for p in first.products}
    all_products = list(first.products)
    pages_fetched = 1
    current_page = 1

    while first.has_next_page if pages_fetched == 1 else result.has_next_page:
        if pages_fetched >= max_pages:
            break
        current_page += 1
        await asyncio.sleep(ALL_PAGES_DELAY)
        result = await amazon.search(
            q, page=current_page, sort=sort,
            min_price=min_price, max_price=max_price,
            brand=brand, rh=rh,
        )
        for p in result.products:
            if p.id not in seen_ids:
                all_products.append(p)
                seen_ids.add(p.id)
        pages_fetched += 1
        if not result.has_next_page:
            break

    first.products = all_products
    first.total_pages_fetched = pages_fetched
    first.has_next_page = False
    return first


async def _fetch_all_pages_flipkart(
    q: str, sort: str | None,
    min_price: int | None, max_price: int | None,
    brand: str | None,
    max_pages: int = 20,
) -> SearchResponse:
    first = await flipkart.search(
        q, page=1, sort=sort,
        min_price=min_price, max_price=max_price,
        brand=brand,
    )
    seen_ids = {p.id for p in first.products}
    all_products = list(first.products)
    pages_fetched = 1
    current_page = 1

    while first.has_next_page if pages_fetched == 1 else result.has_next_page:
        if pages_fetched >= max_pages:
            break
        current_page += 1
        await asyncio.sleep(ALL_PAGES_DELAY)
        result = await flipkart.search(
            q, page=current_page, sort=sort,
            min_price=min_price, max_price=max_price,
            brand=brand,
        )
        # Deduplicate
        for p in result.products:
            if p.id not in seen_ids:
                all_products.append(p)
                seen_ids.add(p.id)
        pages_fetched += 1
        if not result.has_next_page:
            break

    first.products = all_products
    first.total_pages_fetched = pages_fetched
    first.has_next_page = False
    return first


def is_relevant_product(product_title: str, query: str) -> bool:
    title_lower = product_title.lower()
    q_lower = query.lower()

    # 1. Accessory exclusions if not requested in query
    accessory_words = [
        "case", "cover", "back cover", "glass", "tempered", "tempered glass",
        "protector", "screen protector", "skin", "cable", "charger",
        "adapter", "guard", "strap", "pouch", "sleeve", "dock", "stand"
    ]
    if not any(w in q_lower for w in accessory_words):
        if any(re.search(rf"\b{re.escape(w)}\b", title_lower) for w in accessory_words):
            return False

    # 2. Extract core tokens (alphanumeric >= 2 chars, ignoring common filler)
    filler = {"for", "and", "with", "the", "best", "online", "india", "buy", "new", "genuine", "original", "series"}
    q_tokens = [w for w in re.findall(r"[a-z0-9]+", q_lower) if len(w) > 1 and w not in filler]

    if not q_tokens:
        return True

    # Check matching ratio of query tokens
    match_count = sum(1 for t in q_tokens if t in title_lower)
    match_ratio = match_count / len(q_tokens)
    if match_ratio < 0.5:
        return False

    # 3. Model number check: if query has a distinctive alphanumeric model token (e.g. 16, s24, xm5, m3)
    model_tokens = [w for w in q_tokens if any(c.isdigit() for c in w) or w in {"macbook", "ipad", "iphone", "pixel", "galaxy", "bravia"}]
    for mt in model_tokens:
        if mt not in title_lower:
            return False

    # 4. Competing brand conflict check (e.g. if searching iPhone/Apple, reject Samsung/Vivo/OnePlus ads)
    if "iphone" in q_lower or "apple" in q_lower:
        if any(b in title_lower for b in ["galaxy", "samsung", "vivo", "oneplus", "redmi", "xiaomi", "realme", "motorola", "moto", "poco"]):
            return False
    elif "galaxy" in q_lower or "samsung" in q_lower:
        if any(b in title_lower for b in ["iphone", "apple", "pixel", "oneplus", "vivo", "oppo"]):
            return False

    return True


def filter_relevant_products(products: list[Product], query: str) -> list[Product]:
    relevant = [p for p in products if is_relevant_product(p.title, query)]
    return relevant if relevant else products


@app.get(
    "/api/search",
    response_model=list[SearchResponse],
    summary="Unified search across Amazon & Flipkart",
    tags=["Search"],
)
async def search(
    q: Annotated[str, Query(min_length=1, description="Search query (e.g. 'iPhone 15', 'laptop', 'headphones')")],
    source: Annotated[Source, Query(description="Which site(s) to search — `all` queries both in parallel")] = Source.all,
    page: Annotated[int, Query(ge=1, le=50, description="Page number (ignored when `all_pages=true`)")] = 1,
    all_pages: Annotated[bool, Query(description="Fetch ALL pages and return the full product list. Requires at least one filter applied.")] = False,
    max_pages: Annotated[int, Query(ge=1, description="Max pages to fetch when `all_pages=true`")] = 20,
    sort: Annotated[str | None, Query(description="Sort order — Amazon: `price-asc-rank`, `price-desc-rank`, `review-rank`, `date-desc-rank` | Flipkart: `price_asc`, `price_desc`, `popularity`, `recency_desc`")] = None,
    min_price: Annotated[int | None, Query(ge=0, description="Minimum price filter in INR")] = None,
    max_price: Annotated[int | None, Query(ge=0, description="Maximum price filter in INR")] = None,
    brand: Annotated[str | None, Query(description="Brand name filter (e.g. 'Apple', 'Samsung')")] = None,
    strict: Annotated[bool, Query(description="Filter out unrelated recommendations and accessories")] = True,
):
    """
    Search products across Amazon India and Flipkart simultaneously.

    When `source=all`, both sites are queried in parallel and results are returned
    as a list with one entry per source.

    Set `all_pages=true` to automatically paginate through every available page
    and return the complete product list in a single response. This is rate-limited
    to 1 request/second per source. You can control the cap with `max_pages`.

    **Note:** `all_pages` requires at least one filter (`min_price`, `max_price`, `brand`, or `sort`)
    to prevent excessively large unfiltered fetches.
    """
    if all_pages and not _has_filters(sort=sort, min_price=min_price, max_price=max_price, brand=brand):
        raise HTTPException(
            400,
            "all_pages requires at least one filter (sort, min_price, max_price, or brand) "
            "to avoid fetching an excessive number of pages.",
        )

    sources = (
        [Source.amazon, Source.flipkart]
        if source == Source.all
        else [source]
    )

    tasks = []
    for s in sources:
        if all_pages:
            ck = _cache_key(s.value, q=q, all_pages=True, max_pages=max_pages, sort=sort, min_price=min_price, max_price=max_price, brand=brand)
            cached_result = cache.get(*ck)
            if cached_result:
                cached_result.cached = True
                tasks.append(_wrap_cached(cached_result))
            elif s == Source.amazon:
                tasks.append(_fetch_all_cached(
                    _fetch_all_pages_amazon(q, sort, min_price, max_price, brand, None, max_pages), ck
                ))
            else:
                tasks.append(_fetch_all_cached(
                    _fetch_all_pages_flipkart(q, sort, min_price, max_price, brand, max_pages), ck
                ))
        else:
            ck = _cache_key(s.value, q=q, page=page, sort=sort, min_price=min_price, max_price=max_price, brand=brand)
            cached_result = cache.get(*ck)
            if cached_result:
                cached_result.cached = True
                tasks.append(_wrap_cached(cached_result))
            elif s == Source.amazon:
                tasks.append(_search_amazon(q, page, sort, min_price, max_price, brand, ck))
            else:
                tasks.append(_search_flipkart(q, page, sort, min_price, max_price, brand, ck))

    results = await asyncio.gather(*tasks, return_exceptions=True)

    responses = []
    for r in results:
        if isinstance(r, Exception):
            continue
        responses.append(r)

    if not responses:
        raise HTTPException(502, "All sources failed. Try again later.")

    if strict:
        for resp in responses:
            resp.products = filter_relevant_products(resp.products, q)

    return responses


async def _wrap_cached(data: SearchResponse) -> SearchResponse:
    return data


async def _fetch_all_cached(coro, ck: tuple[str, ...]) -> SearchResponse:
    result = await coro
    cache.set(result, *ck)
    return result


async def _search_amazon(
    q: str, page: int, sort: str | None,
    min_price: int | None, max_price: int | None,
    brand: str | None, ck: tuple[str, ...],
) -> SearchResponse:
    result = await amazon.search(
        q, page=page, sort=sort,
        min_price=min_price, max_price=max_price, brand=brand,
    )
    cache.set(result, *ck)
    return result


async def _search_flipkart(
    q: str, page: int, sort: str | None,
    min_price: int | None, max_price: int | None,
    brand: str | None, ck: tuple[str, ...],
) -> SearchResponse:
    result = await flipkart.search(
        q, page=page, sort=sort,
        min_price=min_price, max_price=max_price, brand=brand,
    )
    cache.set(result, *ck)
    return result


@app.get(
    "/api/search/amazon",
    response_model=SearchResponse,
    summary="Search Amazon India",
    tags=["Amazon"],
)
async def search_amazon(
    q: Annotated[str, Query(min_length=1, description="Search query")],
    page: Annotated[int, Query(ge=1, le=50, description="Page number (ignored when `all_pages=true`)")] = 1,
    all_pages: Annotated[bool, Query(description="Fetch ALL pages and return complete product list. Requires at least one filter applied.")] = False,
    max_pages: Annotated[int, Query(ge=1, description="Max pages to fetch when `all_pages=true`")] = 20,
    sort: Annotated[str | None, Query(description="Sort: `price-asc-rank` | `price-desc-rank` | `review-rank` | `date-desc-rank`")] = None,
    min_price: Annotated[int | None, Query(ge=0, description="Min price in INR")] = None,
    max_price: Annotated[int | None, Query(ge=0, description="Max price in INR")] = None,
    brand: Annotated[str | None, Query(description="Brand name (e.g. 'Apple')")] = None,
    rh: Annotated[str | None, Query(description="Raw Amazon `rh` filter parameter — pass the `value` field from any filter option directly")] = None,
):
    """
    Search Amazon India with full filter support.

    **Filters:** Use `brand`, `min_price`, `max_price` for common filters, or pass the
    raw `rh` parameter from the `filters[].options[].value` field in any response for
    advanced filtering (e.g. RAM, storage, customer reviews).

    **Sort options:** `price-asc-rank`, `price-desc-rank`, `review-rank`, `date-desc-rank`

    **All pages:** Set `all_pages=true` to auto-paginate through every page.
    Requires at least one filter to be applied. Control the cap using `max_pages`.
    """
    if all_pages and not _has_filters(sort=sort, min_price=min_price, max_price=max_price, brand=brand, rh=rh):
        raise HTTPException(
            400,
            "all_pages requires at least one filter (sort, min_price, max_price, brand, or rh) "
            "to avoid fetching an excessive number of pages.",
        )

    if all_pages:
        ck = _cache_key("amazon", q=q, all_pages=True, max_pages=max_pages, sort=sort, min_price=min_price, max_price=max_price, brand=brand, rh=rh)
        cached_result = cache.get(*ck)
        if cached_result:
            cached_result.cached = True
            return cached_result
        result = await _fetch_all_pages_amazon(q, sort, min_price, max_price, brand, rh, max_pages)
        cache.set(result, *ck)
        return result

    ck = _cache_key("amazon", q=q, page=page, sort=sort, min_price=min_price, max_price=max_price, brand=brand, rh=rh)
    cached_result = cache.get(*ck)
    if cached_result:
        cached_result.cached = True
        return cached_result

    result = await amazon.search(
        q, page=page, sort=sort,
        min_price=min_price, max_price=max_price,
        brand=brand, rh=rh,
    )
    cache.set(result, *ck)
    return result


@app.get(
    "/api/search/flipkart",
    response_model=SearchResponse,
    summary="Search Flipkart",
    tags=["Flipkart"],
)
async def search_flipkart(
    q: Annotated[str, Query(min_length=1, description="Search query")],
    page: Annotated[int, Query(ge=1, le=50, description="Page number (ignored when `all_pages=true`)")] = 1,
    all_pages: Annotated[bool, Query(description="Fetch ALL pages and return complete product list. Requires at least one filter applied.")] = False,
    max_pages: Annotated[int, Query(ge=1, description="Max pages to fetch when `all_pages=true`")] = 20,
    sort: Annotated[str | None, Query(description="Sort: `price_asc` | `price_desc` | `popularity` | `recency_desc` | `rating_desc`")] = None,
    min_price: Annotated[int | None, Query(ge=0, description="Min price in INR")] = None,
    max_price: Annotated[int | None, Query(ge=0, description="Max price in INR")] = None,
    brand: Annotated[str | None, Query(description="Brand name (e.g. 'Samsung'). Comma-separated for multiple.")] = None,
):
    """
    Search Flipkart with full filter support.

    **Filters:** Use `brand`, `min_price`, `max_price` for common filters.

    **Sort options:** `price_asc`, `price_desc`, `popularity`, `recency_desc`, `rating_desc`

    **All pages:** Set `all_pages=true` to auto-paginate through every page.
    Requires at least one filter to be applied. Control the cap using `max_pages`.
    """
    if all_pages and not _has_filters(sort=sort, min_price=min_price, max_price=max_price, brand=brand):
        raise HTTPException(
            400,
            "all_pages requires at least one filter (sort, min_price, max_price, or brand) "
            "to avoid fetching an excessive number of pages.",
        )

    if all_pages:
        ck = _cache_key("flipkart", q=q, all_pages=True, max_pages=max_pages, sort=sort, min_price=min_price, max_price=max_price, brand=brand)
        cached_result = cache.get(*ck)
        if cached_result:
            cached_result.cached = True
            return cached_result
        result = await _fetch_all_pages_flipkart(q, sort, min_price, max_price, brand, max_pages)
        cache.set(result, *ck)
        return result

    ck = _cache_key("flipkart", q=q, page=page, sort=sort, min_price=min_price, max_price=max_price, brand=brand)
    cached_result = cache.get(*ck)
    if cached_result:
        cached_result.cached = True
        return cached_result

    result = await flipkart.search(
        q, page=page, sort=sort,
        min_price=min_price, max_price=max_price,
        brand=brand,
    )
    cache.set(result, *ck)
    return result


@app.delete(
    "/api/cache",
    summary="Clear response cache",
    tags=["Utility"],
)
async def clear_cache():
    """Purge all cached search responses. The next request for any query will hit the source site live."""
    cache.clear()
    return {"status": "ok", "message": "Cache cleared"}


@app.get(
    "/api/config",
    summary="Client configuration for Supabase",
    tags=["Utility"],
)
async def get_config():
    """Returns public configuration for client-side Supabase authentication and storage."""
    return {
        "supabase_url": os.getenv("SUPABASE_URL", ""),
        "supabase_anon_key": os.getenv("SUPABASE_ANON_KEY", ""),
    }


SETTINGS_FILE = Path(__file__).resolve().parent / "settings.json"


def _read_settings() -> dict:
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "brand_name": "PriceScout",
        "badge_text": "Live dual-store price sync",
        "hero_headline_1": "Find the best price.",
        "hero_headline_2": "Keep more in your pocket.",
        "hero_subtitle": "Compare real prices from India's trusted electronics stores, all in one place.",
        "strict_filter_default": True,
    }


def _save_settings(data: dict) -> None:
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


@app.get("/api/settings", summary="Get Site Settings", tags=["Admin"])
async def get_settings():
    return _read_settings()


@app.post("/api/admin/settings", summary="Update Site Settings", tags=["Admin"])
async def update_settings(settings: dict):
    current = _read_settings()
    current.update(settings)
    _save_settings(current)
    return {"status": "ok", "settings": current}


@app.get("/api/admin/stats", summary="Admin system statistics", tags=["Admin"])
async def get_admin_stats():
    supa_url = os.getenv("SUPABASE_URL", "")
    supa_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "") or os.getenv("SUPABASE_ANON_KEY", "")
    wishlist_count = 0
    if supa_url and supa_key:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                res = await client.get(
                    f"{supa_url}/rest/v1/wishlist?select=id",
                    headers={"apikey": supa_key, "Authorization": f"Bearer {supa_key}", "Range": "0-0", "Prefer": "count=exact"}
                )
                cr = res.headers.get("content-range", "")
                if "/" in cr:
                    wishlist_count = int(cr.split("/")[1])
                elif res.status_code == 200:
                    wishlist_count = len(res.json())
        except Exception:
            pass

    return {
        "cache_items_count": len(cache._store),
        "supabase_connected": bool(supa_url and supa_key),
        "total_wishlist_items": wishlist_count,
        "scrapers": {
            "amazon": "online",
            "flipkart": "online",
        }
    }


@app.get("/api/admin/wishlist", summary="View all wishlists (Admin)", tags=["Admin"])
async def get_admin_wishlist():
    supa_url = os.getenv("SUPABASE_URL", "")
    supa_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "") or os.getenv("SUPABASE_ANON_KEY", "")
    if not supa_url or not supa_key:
        return {"items": []}
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            res = await client.get(
                f"{supa_url}/rest/v1/wishlist?select=*&order=created_at.desc",
                headers={"apikey": supa_key, "Authorization": f"Bearer {supa_key}"}
            )
            if res.status_code == 200:
                return {"items": res.json()}
    except Exception as e:
        return {"items": [], "error": str(e)}
    return {"items": []}


@app.delete("/api/admin/wishlist/{item_id}", summary="Delete wishlist item (Admin)", tags=["Admin"])
async def delete_admin_wishlist_item(item_id: str):
    supa_url = os.getenv("SUPABASE_URL", "")
    supa_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "") or os.getenv("SUPABASE_ANON_KEY", "")
    if not supa_url or not supa_key:
        raise HTTPException(400, "Supabase credentials missing")
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            res = await client.delete(
                f"{supa_url}/rest/v1/wishlist?id=eq.{item_id}",
                headers={"apikey": supa_key, "Authorization": f"Bearer {supa_key}"}
            )
            return {"status": "ok"}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get(
    "/health",
    summary="Health check",
    tags=["Utility"],
)
async def health():
    """Returns `{\"status\": \"ok\"}` if the API is running."""
    return {"status": "ok"}


# Mount static assets and serve root UI
STATIC_DIR = Path(__file__).resolve().parent / "static"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get(
    "/",
    summary="PriceScout Price Comparison Web Interface",
    tags=["UI"],
    include_in_schema=False,
)
async def serve_ui():
    """Serves the PriceScout real-time price comparison frontend."""
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return {"message": "PriceScout API is running. UI file not found."}


@app.get("/admin", summary="Admin Panel", tags=["Admin"], include_in_schema=False)
async def serve_admin():
    """Serves the Admin Management Panel."""
    admin_file = STATIC_DIR / "admin.html"
    if admin_file.exists():
        return FileResponse(str(admin_file))
    return {"message": "Admin panel file not found."}


