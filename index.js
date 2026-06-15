import pkg from "stremio-addon-sdk";
const { addonBuilder, serveHTTP } = pkg;
import axios from "axios";
import express from "express";
import os from "os";
let DOMParser, XMLSerializer;
try {
    ({ DOMParser, XMLSerializer } = await import("@xmldom/xmldom"));
} catch {
    // xmldom not installed — will use regex fallback for ad stripping
}

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────
// Auto-detect LAN IP so MPD proxy URLs are reachable from other devices (e.g. a TV).
// Set PROXY_HOST env var to override (e.g. PROXY_HOST=192.168.1.50).
function getLanIp() {
    if (process.env.PROXY_HOST) return process.env.PROXY_HOST;
    try {
        const nets = os.networkInterfaces();
        for (const iface of Object.values(nets)) {
            for (const addr of iface) {
                if (addr.family === "IPv4" && !addr.internal) return addr.address;
            }
        }
    } catch {}
    return "localhost";
}

const CONFIG = {
    PORT: parseInt(process.env.PORT) || 7000,
    PROXY_HOST: getLanIp(),
    TVDB_API_KEY: process.env.TVDB_API_KEY || "",
    DEBUG: process.env.DEBUG === "true",
    REQUEST_TIMEOUT_MS: 15000,  // 15s for ViX API (can be slow during warmup)
    TVDB_TIMEOUT_MS: 10000,     // 10s for TVDB API
    MAX_EPISODES_PER_FETCH: 150,
};

if (!CONFIG.TVDB_API_KEY) {
    console.warn("[Config Warning] TVDB_API_KEY is not set. Automatic episode mapping will be disabled.");
}

// TVDB v4 bearer token (obtained once at startup, refreshed on 401)
let tvdbBearerToken = null;

// ─────────────────────────────────────────────
// In-memory caches
// ─────────────────────────────────────────────
const tvdbIdCache    = new Map(); // imdbId → TVDB series ID
const episodeMapCache = new Map(); // imdbId → { tvdbToVix, builtAt }

// ─────────────────────────────────────────────
// Schema overrides (coreId → schema object)
// Add manual overrides here if auto-detection
// picks the wrong schema for a show.
// Example: { "12345": { type: "year-based", startYear: 2008 } }
// ─────────────────────────────────────────────
const SCHEMA_OVERRIDES = {};

// ─────────────────────────────────────────────
// Logging helpers
// ─────────────────────────────────────────────
const log = {
    info:  (...a) => CONFIG.DEBUG && console.log("[INFO]", ...a),
    warn:  (...a) => console.warn("[WARN]", ...a),
    error: (...a) => console.error("[ERROR]", ...a),
};

// ─────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────
const manifest = {
    id: "community.vixwatchhub.live",
    version: "1.0.0",
    name: "Vix Hub Pro",
    description: "Routes Stremio requests to ViX streaming URLs via GraphQL content resolution.",
    logo: "https://www.vix.com/favicon.ico",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
};

const builder = new addonBuilder(manifest);

// ─────────────────────────────────────────────
// Local IMDB → Title registry
// ─────────────────────────────────────────────
const LOCAL_TITLE_DB = {
    "tt1192302": "La rosa de Guadalupe",
    "tt2266983": "Amor Bravio",
    "tt0292813": "Rubi",
    "tt0120593": "La Usurpadora",
};

// ─────────────────────────────────────────────
// Episodes missing on ViX — auto-populated at
// startup by detectMissingVixEpisodes().
// Keyed by imdbId → Set of "tvdbSeason:tvdbEpisode"
// ─────────────────────────────────────────────
const MISSING_ON_VIX = {};

// ─────────────────────────────────────────────
// Scan every ViX season for a show and detect
// gaps by reading episode numbers from titles.
// ViX embeds the episode number in the title,
// e.g. "Episodio 83" or "Capítulo 83".
// A gap means that episode was deleted from ViX.
//
// Returns a Set of "tvdbSeason:tvdbEpisode" strings
// by cross-referencing with the TVDB episode list.
// ─────────────────────────────────────────────
async function detectMissingVixEpisodes(imdbId, coreId, schema, tvdbEpisodes) {
    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Origin": "https://vix.com",
        "Referer": `https://vix.com/es-es/detail/series-${coreId}`,
    };

    // Extract all episode numbers present in a season's JSON response
    const getEpisodeNumbers = (jsonString) => {
        const nums = new Set();

        // Try explicit episodeNumber fields first
        const numRegex = /(?:"episodeNumber"|"number"|"sequence")\s*:\s*(\d+)/g;
        let m;
        while ((m = numRegex.exec(jsonString)) !== null) {
            const n = parseInt(m[1]);
            if (n > 0) nums.add(n);
        }

        // Also parse from title strings like "Episodio 83" / "Capítulo 83" / "Ep. 83"
        const titleRegex = /(?:Episodio|Capítulo|Capitulo|Ep\.?)\s+(\d+)/gi;
        while ((m = titleRegex.exec(jsonString)) !== null) {
            const n = parseInt(m[1]);
            if (n > 0) nums.add(n);
        }

        return nums;
    };

    // Collect all ViX episode numbers across all seasons, keyed by ViX season
    const vixEpsByseason = [];
    let vixSeason = 1;

    while (vixSeason <= 50) {
        const seasonNums = new Set();

        if (schema.type === "year-based") {
            const year = schema.startYear + (vixSeason - 1);
            const seasonId = `season:mcp:${coreId}_${year}`;
            const variables = {
                seasonId,
                seriesId: `series:mcp:${coreId}`,
                episodePagination: { first: CONFIG.MAX_EPISODES_PER_FETCH, after: null },
                navigationSection: { pageItemId: "", urlPath: `/detail/series:mcp:${coreId}` },
            };
            const url = `https://vix.com/api/capi?queryName=SeasonDataQuery` +
                `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
                `&referralPath=&shouldSkipAvailabilityCheck=false`;
            try {
                const { data: raw } = await axios.get(url, { headers, timeout: CONFIG.REQUEST_TIMEOUT_MS });
                const js = JSON.stringify(raw);
                if (!/video:(?:mcp:)?\d+/.test(js)) break;
                for (const n of getEpisodeNumbers(js)) seasonNums.add(n);
            } catch { break; }

        } else {
            // chunk-based: scan all batches
            let batch = 1;
            let hadAny = false;
            while (true) {
                const seasonId = `season:mcp:${coreId}_${vixSeason}:novelaSeasonId:${batch}`;
                const variables = {
                    seasonId,
                    seriesId: `series:mcp:${coreId}`,
                    episodePagination: { first: CONFIG.MAX_EPISODES_PER_FETCH, after: null },
                    navigationSection: { pageItemId: "", urlPath: `/detail/series:mcp:${coreId}` },
                };
                const url = `https://vix.com/api/capi?queryName=SeasonDataQuery` +
                    `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
                    `&referralPath=&shouldSkipAvailabilityCheck=false`;
                try {
                    const { data: raw } = await axios.get(url, { headers, timeout: CONFIG.REQUEST_TIMEOUT_MS });
                    const js = JSON.stringify(raw);
                    if (!/video:(?:mcp:)?\d+/.test(js)) break;
                    hadAny = true;
                    for (const n of getEpisodeNumbers(js)) seasonNums.add(n);
                    batch++;
                } catch { break; }
            }
            if (!hadAny) break;
        }

        if (seasonNums.size === 0) break;
        vixEpsByseason.push({ vixSeason, nums: seasonNums });
        log.info(`ViX S${vixSeason} episode numbers present: ${[...seasonNums].sort((a,b)=>a-b).slice(0,10).join(",")}…`);
        vixSeason++;
    }

    if (!vixEpsByseason.length) return new Set();

    // All episode numbers present on ViX (flat set, since they're globally unique per show)
    const allVixNums = new Set();
    for (const { nums } of vixEpsByseason) for (const n of nums) allVixNums.add(n);

    // Find the max episode number ViX has
    const maxVixNum = Math.max(...allVixNums);

    // Any integer in [1, maxVixNum] not in allVixNums is a gap
    const gaps = [];
    for (let i = 1; i <= maxVixNum; i++) {
        if (!allVixNums.has(i)) gaps.push(i);
    }

    if (!gaps.length) {
        log.info(`No missing episodes detected on ViX for ${imdbId}`);
        return new Set();
    }

    console.log(`[GAP DETECTION] Gaps in ViX episode numbers for ${imdbId}: ${gaps.join(", ")}`);

    // Map gap numbers → TVDB "season:episode" keys using the flat TVDB episode list
    // TVDB episodes are already sorted by season+episode, so their position
    // in the flat list equals their global episode number (1-based).
    const missing = new Set();
    for (const gapNum of gaps) {
        const ep = tvdbEpisodes[gapNum - 1]; // flat index
        if (ep) {
            const key = `${ep.tvdbSeason}:${ep.tvdbEpisode}`;
            missing.add(key);
            console.log(`[GAP DETECTION] Gap #${gapNum} → TVDB ${key} marked as missing on ViX`);
        }
    }

    return missing;
}

// ─────────────────────────────────────────────
// TVDB v3 (legacy) episode fetching
// Flow:
//   A. POST /login with apikey → JWT bearer token (cached, refresh on 401)
//   B. GET /search/series?imdbId= → TVDB series ID
//   C. GET /series/{id}/episodes?page= (100/page) → all episodes, sorted by air date
// ─────────────────────────────────────────────
const TVDB_BASE = "https://api.thetvdb.com";

// Step A: Obtain / refresh a TVDB v3 JWT
async function getTvdbToken() {
    if (tvdbBearerToken) return tvdbBearerToken;

    const { data } = await axios.post(
        `${TVDB_BASE}/login`,
        { apikey: CONFIG.TVDB_API_KEY },
        { timeout: CONFIG.TVDB_TIMEOUT_MS }
    );

    tvdbBearerToken = data?.token || null;
    if (!tvdbBearerToken) throw new Error("TVDB login returned no token");
    log.info("TVDB v3 bearer token acquired");
    return tvdbBearerToken;
}

// Thin authenticated GET wrapper; retries once on 401 (token expiry)
async function tvdbGet(path, params = {}) {
    const makeRequest = async (token) =>
        axios.get(`${TVDB_BASE}${path}`, {
            headers: { Authorization: `Bearer ${token}` },
            params,
            timeout: CONFIG.REQUEST_TIMEOUT_MS,
        });

    try {
        const token = await getTvdbToken();
        const { data } = await makeRequest(token);
        return data;
    } catch (err) {
        if (err.response?.status === 401) {
            tvdbBearerToken = null; // force re-login
            const freshToken = await getTvdbToken();
            const { data } = await makeRequest(freshToken);
            return data;
        }
        throw err;
    }
}

// Step B: IMDB ID → TVDB series ID
async function getTvdbSeriesId(imdbId) {
    if (tvdbIdCache.has(imdbId)) return tvdbIdCache.get(imdbId);

    try {
        const data = await tvdbGet("/search/series", { imdbId });
        const result = data?.data?.[0];

        if (!result?.id) {
            log.warn(`No TVDB series found for ${imdbId}`);
            tvdbIdCache.set(imdbId, null);
            return null;
        }

        log.info(`TVDB series ID resolved: ${imdbId} → ${result.id}`);
        tvdbIdCache.set(imdbId, result.id);
        return result.id;

    } catch (err) {
        log.warn(`TVDB series ID lookup failed for ${imdbId}: ${err.message}`);
        return null;
    }
}

// Step C: Fetch all episodes for a TVDB series ID, sorted by air date.
// Returns array of { tvdbSeason, tvdbEpisode, airDate } for buildEpisodeMap.
// TVDB v3 paginates at 100 episodes per page, starting at page 1.
async function fetchAllTvdbEpisodes(tvdbSeriesId) {
    const allEpisodes = [];
    let page = 1;

    while (true) {
        try {
            const data = await tvdbGet(`/series/${tvdbSeriesId}/episodes`, { page });
            const episodes = data?.data || [];

            if (!episodes.length) break;

            for (const ep of episodes) {
                if (!ep.airedEpisodeNumber || !ep.firstAired) continue;
                allEpisodes.push({
                    tvdbSeason:  ep.airedSeason,
                    tvdbEpisode: ep.airedEpisodeNumber,
                    airDate:     ep.firstAired, // "YYYY-MM-DD"
                });
            }

            log.info(`TVDB: page ${page} → ${episodes.length} episodes`);

            const lastPage = data?.links?.last ?? page;
            if (page >= lastPage) break;
            page++;
        } catch (err) {
            log.warn(`TVDB: failed to fetch page ${page} for series ${tvdbSeriesId}: ${err.message}`);
            break;
        }
    }

    // Sort by TVDB season → episode number (broadcast order).
    // Air-date sort is unreliable when multiple episodes share the same date
    // (common in telenovelas), which causes misalignment with ViX's ordering.
    allEpisodes.sort((a, b) => {
        if (a.tvdbSeason !== b.tvdbSeason) return a.tvdbSeason - b.tvdbSeason;
        return a.tvdbEpisode - b.tvdbEpisode;
    });
    log.info(`TVDB: ${allEpisodes.length} total episodes fetched for series ${tvdbSeriesId} (sorted by S/E)`);
    return allEpisodes;
}

// ─────────────────────────────────────────────
// Fetch the real episode count for every ViX
// season by querying SeasonDataQuery until a
// season comes back empty.
// Returns array of counts: [S1count, S2count, …]
// ─────────────────────────────────────────────
async function getVixSeasonEpisodeCounts(coreId, schema) {
    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Origin": "https://vix.com",
        "Referer": `https://vix.com/es-es/detail/series-${coreId}`,
    };

    const fetchSeasonTokens = async (seasonId, seen = new Set()) => {
        const variables = {
            seasonId,
            seriesId: `series:mcp:${coreId}`,
            episodePagination: { first: CONFIG.MAX_EPISODES_PER_FETCH, after: null },
            navigationSection: { pageItemId: "", urlPath: `/detail/series:mcp:${coreId}` },
        };
        const url = `https://vix.com/api/capi?queryName=SeasonDataQuery` +
            `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
            `&referralPath=&shouldSkipAvailabilityCheck=false`;
        const { data: raw } = await axios.get(url, { headers, timeout: CONFIG.REQUEST_TIMEOUT_MS });
        const tokenRegex = /video:(?:mcp:)?(\d+)/g;
        let m;
        while ((m = tokenRegex.exec(JSON.stringify(raw))) !== null) {
            if (m[1] && m[1] !== coreId) seen.add(m[1]);
        }
        return seen;
    };

    const counts = [];
    let vixSeason = 1;

    while (vixSeason <= 50) {
        try {
            let seen;

            if (schema.type === "year-based") {
                const year = schema.startYear + (vixSeason - 1);
                seen = await fetchSeasonTokens(`season:mcp:${coreId}_${year}`);
            } else {
                // chunk-based: accumulate across all batches for this season
                seen = new Set();
                let batch = 1;
                while (true) {
                    const prevSize = seen.size;
                    try {
                        await fetchSeasonTokens(`season:mcp:${coreId}_${vixSeason}:novelaSeasonId:${batch}`, seen);
                    } catch { break; }
                    if (seen.size === prevSize) break;
                    batch++;
                }
            }

            if (seen.size === 0) {
                log.info(`ViX S${vixSeason} empty — season scan complete`);
                break;
            }

            log.info(`ViX S${vixSeason} → ${seen.size} episodes`);
            counts.push(seen.size);
            vixSeason++;
        } catch (err) {
            log.warn(`ViX season count probe S${vixSeason} failed: ${err.message}`);
            break;
        }
    }

    return counts;
}

// ─────────────────────────────────────────────
// Build the TVDB → ViX episode map for a show.
//
// Logic:
//   1. Fetch all TVDB episodes sorted by air date → flat ordered list
//   2. Fetch actual ViX episode counts per season from ViX itself
//   3. Use cumulative offsets to assign each TVDB episode
//      its ViX season and in-season position
//   4. Store as a flat lookup Map for O(1) resolution
// ─────────────────────────────────────────────
async function buildEpisodeMap(imdbId, coreId = null, schema = null) {
    if (!CONFIG.TVDB_API_KEY) return null;

    const cached = episodeMapCache.get(imdbId);

    // Return fully built map immediately
    if (cached && !cached.pending) {
        log.info(`Episode map cache hit for ${imdbId}`);
        return cached;
    }

    // Reuse TVDB episodes from pending cache if available
    let allEpisodes = cached?.tvdbEpisodes ?? null;

    if (!allEpisodes) {
        console.log(`[TVDB] Fetching TVDB episodes for ${imdbId}…`);
        const tvdbId = await getTvdbSeriesId(imdbId);
        if (!tvdbId) return null;
        try {
            allEpisodes = await fetchAllTvdbEpisodes(tvdbId);
        } catch (err) {
            log.error(`Failed to fetch TVDB episodes for ${tvdbId}: ${err.message}`);
            return null;
        }
        if (!allEpisodes.length) return null;
    }

    // Warmup path: no ViX info yet — cache TVDB data and wait
    if (!coreId || !schema) {
        console.log(`[TVDB] Episode map for ${imdbId}: TVDB data cached, awaiting ViX coreId/schema`);
        episodeMapCache.set(imdbId, { tvdbEpisodes: allEpisodes, builtAt: new Date(), pending: true });
        return null;
    }

    // Fetch real per-season episode counts from ViX
    console.log(`[TVDB] Fetching ViX season episode counts for ${imdbId} (coreId=${coreId})…`);
    const vixCounts = await getVixSeasonEpisodeCounts(coreId, schema);

    if (!vixCounts.length) {
        log.warn(`Could not determine ViX season counts for ${imdbId}, falling back to 1:1`);
        episodeMapCache.delete(imdbId);
        return null;
    }

    console.log(`[TVDB] ViX season counts for ${imdbId}: [${vixCounts.join(", ")}]`);

    // Auto-detect missing episodes from ViX episode number gaps
    if (!MISSING_ON_VIX[imdbId]) {
        console.log(`[TVDB] Scanning ViX for missing episodes in ${imdbId}…`);
        MISSING_ON_VIX[imdbId] = await detectMissingVixEpisodes(imdbId, coreId, schema, allEpisodes);
        const count = MISSING_ON_VIX[imdbId].size;
        console.log(`[TVDB] Missing episode detection complete: ${count} episode(s) missing on ViX for ${imdbId}`);
    }

    // Cumulative breakpoints: total TVDB episodes assigned after each ViX season
    const breakpoints = [];
    let cumulative = 0;
    for (const count of vixCounts) {
        cumulative += count;
        breakpoints.push(cumulative);
    }

    const missingSet = MISSING_ON_VIX[imdbId] ?? new Set();
    const tvdbToVix = new Map();
    let debugLogged = 0;
    let vixIndex = 0; // only increments for episodes that exist on ViX

    for (const ep of allEpisodes) {
        const key = `${ep.tvdbSeason}:${ep.tvdbEpisode}`;

        if (missingSet.has(key)) {
            log.info(`Skipping missing episode TVDB S${ep.tvdbSeason}E${ep.tvdbEpisode} (not on ViX)`);
            tvdbToVix.set(key, null); // null = not available on ViX
            continue;
        }

        const globalIndex = vixIndex;
        vixIndex++;

        let vixSeason = breakpoints.length;
        let episodesBefore = breakpoints.length > 1 ? breakpoints[breakpoints.length - 2] : 0;

        for (let i = 0; i < breakpoints.length; i++) {
            if (globalIndex < breakpoints[i]) {
                vixSeason = i + 1;
                episodesBefore = i === 0 ? 0 : breakpoints[i - 1];
                break;
            }
        }

        const vixEpisode = globalIndex - episodesBefore + 1;

        // Log the first entry of each ViX season so offsets are visible
        if (vixEpisode === 1 && debugLogged < 20) {
            log.info(`ViX S${vixSeason}E1 ← TVDB S${ep.tvdbSeason}E${ep.tvdbEpisode} (global #${globalIndex + 1})`);
            debugLogged++;
        }

        tvdbToVix.set(key, { vixSeason, vixEpisode });
    }

    const result = { tvdbToVix, vixCounts, builtAt: new Date(), pending: false };
    episodeMapCache.set(imdbId, result);
    log.info(`Episode map built: ${tvdbToVix.size} entries for ${imdbId}`);
    return result;
}

// ─────────────────────────────────────────────
// Resolve TVDB (season, episode) → ViX (season, episode)
// coreId and schema are forwarded so buildEpisodeMap
// can finalize a pending map on first stream request.
// ─────────────────────────────────────────────
async function resolveVixSeasonEpisode(imdbId, tvdbSeason, tvdbEpisode, coreId, schema) {
    const map = await buildEpisodeMap(imdbId, coreId, schema);

    if (!map) {
        log.warn(`No episode map for ${imdbId}, passing through S${tvdbSeason}E${tvdbEpisode}`);
        return { vixSeason: tvdbSeason, vixEpisode: tvdbEpisode, missing: false };
    }

    const key = `${tvdbSeason}:${tvdbEpisode}`;
    const resolved = map.tvdbToVix.get(key);

    if (resolved === null) {
        log.warn(`TVDB S${tvdbSeason}E${tvdbEpisode} is marked as not available on ViX`);
        return { missing: true };
    }

    if (resolved) {
        log.info(`Resolved: TVDB S${tvdbSeason}E${tvdbEpisode} → ViX S${resolved.vixSeason}E${resolved.vixEpisode}`);
        return { ...resolved, missing: false };
    }

    log.warn(`TVDB S${tvdbSeason}E${tvdbEpisode} not found in map, passing through`);
    return { vixSeason: tvdbSeason, vixEpisode: tvdbEpisode, missing: false };
}

// ─────────────────────────────────────────────
// Utility: retrying axios GET
// ─────────────────────────────────────────────
async function fetchWithRetry(url, options = {}, retries = 2) {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
            return await axios.get(url, options);
        } catch (err) {
            const isLast = attempt === retries + 1;
            if (isLast) throw err;
            log.warn(`Retry ${attempt}/${retries} for ${url} — ${err.message}`);
            await new Promise(r => setTimeout(r, 500 * attempt));
        }
    }
}

// ─────────────────────────────────────────────
// Step 1: Resolve IMDB ID → human title
// ─────────────────────────────────────────────
async function getMediaMetadata(type, imdbId) {
    if (LOCAL_TITLE_DB[imdbId]) {
        log.info(`Local registry hit: ${imdbId} → "${LOCAL_TITLE_DB[imdbId]}"`);
        return { title: LOCAL_TITLE_DB[imdbId] };
    }

    if (!CONFIG.TVDB_API_KEY) {
        log.warn(`No TVDB key and "${imdbId}" is not in local registry.`);
        return null;
    }

    try {
        // v3: search by imdbId first, fall back to name search using the imdbId as a hint
        const data = await tvdbGet("/search/series", { imdbId });
        const result = data?.data?.[0];
        const title = result?.seriesName || null;

        if (title) {
            log.info(`TVDB resolved: ${imdbId} → "${title}"`);
            return { title };
        }
    } catch (err) {
        log.warn(`TVDB lookup failed for ${imdbId}: ${err.message}`);
    }

    return null;
}

// ─────────────────────────────────────────────
// Step 2: Search ViX GraphQL → numeric core ID
// ─────────────────────────────────────────────
async function getVixContentId(title, type) {
    if (!title) return null;

    const cleanTitle = title.replace(/\s*\(\d{4}\)\s*/g, "").trim();

    const variables = encodeURIComponent(JSON.stringify({
        searchQuery: cleanTitle,
        pagination: { first: 5, after: null },
    }));

    const url = `https://vix.com/api/capi?queryName=SearchV2DataQuery` +
        `&variables=${variables}&referralPath=&shouldSkipAvailabilityCheck=false`;

    try {
        const { data: raw } = await fetchWithRetry(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            timeout: CONFIG.REQUEST_TIMEOUT_MS,
        });

        const data  = raw?.data || raw;
        const edges = data?.searchVideosV2?.contentConnection?.edges || [];

        if (!edges.length) {
            log.warn(`No ViX search results for "${cleanTitle}"`);
            return null;
        }

        const isSeriesNode = n => n.videoType === "SERIES" || n.__typename === "Series";
        const match = edges.find(e => {
            const node = e.node || e;
            return type === "series" ? isSeriesNode(node) : !isSeriesNode(node);
        });

        const targetNode = match ? (match.node || match) : (edges[0].node || edges[0]);
        const numericId  = targetNode.id?.match(/\d+/)?.[0];

        if (numericId) {
            log.info(`ViX search: "${cleanTitle}" → core ID ${numericId}`);
            return numericId;
        }
    } catch (err) {
        log.error(`ViX search failed for "${cleanTitle}": ${err.message}`);
    }

    return null;
}

// ─────────────────────────────────────────────
// Step 3: Auto-detect season schema
// ─────────────────────────────────────────────
async function detectSeasonSchema(coreId) {
    if (SCHEMA_OVERRIDES[coreId]) {
        log.info(`Using schema override for coreId ${coreId}`);
        return SCHEMA_OVERRIDES[coreId];
    }

    const probeCandidates = [
        `season:mcp:${coreId}_1:novelaSeasonId:1`,
        `season:mcp:${coreId}_2008`,
    ];

    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Origin": "https://vix.com",
        "Referer": `https://vix.com/es-es/detail/series-${coreId}`,
    };

    for (const probeSeasonId of probeCandidates) {
        const variables = {
            seasonId: probeSeasonId,
            seriesId: `series:mcp:${coreId}`,
            episodePagination: { first: 5, after: null },
            navigationSection: { pageItemId: "", urlPath: `/detail/series:mcp:${coreId}` },
        };

        const url = `https://vix.com/api/capi?queryName=SeasonDataQuery` +
            `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
            `&referralPath=&shouldSkipAvailabilityCheck=false`;

        try {
            const { data: raw } = await axios.get(url, { headers, timeout: CONFIG.REQUEST_TIMEOUT_MS });
            const jsonString = JSON.stringify(raw);

            const yearMatches = [...jsonString.matchAll(/season:mcp:\d+_(\d{4})(?!\d)/g)];
            const hasChunk    = /novelaSeasonId/.test(jsonString);
            const hasVideos   = /video:(?:mcp:)?\d+/.test(jsonString);

            if (!hasVideos) continue;

            if (yearMatches.length > 0) {
                const startYear = Math.min(...yearMatches.map(m => parseInt(m[1])));
                log.info(`Schema detected for ${coreId}: year-based, startYear=${startYear}`);
                return { type: "year-based", startYear };
            }

            if (hasChunk) {
                log.info(`Schema detected for ${coreId}: chunk-based`);
                return { type: "chunk-based" };
            }

            return { type: "chunk-based" };

        } catch (err) {
            log.warn(`Schema probe "${probeSeasonId}" failed: ${err.message}`);
        }
    }

    log.warn(`All schema probes failed for ${coreId}, defaulting to chunk-based`);
    return { type: "chunk-based" };
}

// ─────────────────────────────────────────────
// Step 4: Extract video token for the episode
// ─────────────────────────────────────────────
async function extractVideoToken(coreId, season, episode, schema) {
    let seasonId;

    if (schema.type === "year-based") {
        const targetYear = schema.startYear + (parseInt(season) - 1);
        seasonId = `season:mcp:${coreId}_${targetYear}`;
        log.info(`Year-based: S${season} → year ${targetYear}`);
    } else {
        const batchPage = Math.ceil(episode / 20);
        seasonId = `season:mcp:${coreId}_${season}:novelaSeasonId:${batchPage}`;
        log.info(`Chunk-based: S${season}E${episode} → batch ${batchPage}`);
    }

    const variables = {
        seasonId,
        seriesId: `series:mcp:${coreId}`,
        episodePagination: { first: CONFIG.MAX_EPISODES_PER_FETCH, after: null },
        navigationSection: { pageItemId: "", urlPath: `/detail/series:mcp:${coreId}` },
    };

    const url = `https://vix.com/api/capi?queryName=SeasonDataQuery` +
        `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
        `&referralPath=&shouldSkipAvailabilityCheck=false`;

    let response;
    try {
        response = await fetchWithRetry(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                "Accept": "application/json",
                "Origin": "https://vix.com",
                "Referer": `https://vix.com/es-es/detail/series-${coreId}`,
            },
            timeout: CONFIG.REQUEST_TIMEOUT_MS,
        });
    } catch (err) {
        log.error(`Season fetch failed: ${err.message}`);
        return null;
    }

    if (!response?.data) return null;

    const jsonString = JSON.stringify(response.data);

    // Pass 1: explicit episodeNumber mapping
    const explicitMap = {};
    const blockRegex = /\{(?:[^{}]*?"id"\s*:\s*"video:(?:mcp:)?(\d+)"[^{}]*?(?:"episodeNumber"|"number"|"sequence")\s*:\s*(\d+)|(?:"episodeNumber"|"number"|"sequence")\s*:\s*(\d+)[^{}]*?"id"\s*:\s*"video:(?:mcp:)?(\d+)")\}/g;
    let m;
    while ((m = blockRegex.exec(jsonString)) !== null) {
        const videoId = m[1] || m[4];
        const epNum   = parseInt(m[2] || m[3]);
        if (videoId && epNum && !(epNum in explicitMap)) {
            explicitMap[epNum] = videoId;
        }
    }

    if (explicitMap[episode]) {
        log.info(`Explicit match: E${episode} → video-${explicitMap[episode]}`);
        return `video-${explicitMap[episode]}`;
    }

    // Pass 2: sequential position fallback
    const tokenRegex    = /video:(?:mcp:)?(\d+)/g;
    const seenTokens    = new Set();
    const orderedTokens = [];

    while ((m = tokenRegex.exec(jsonString)) !== null) {
        const vid = m[1];
        if (vid && vid !== coreId && !seenTokens.has(vid)) {
            seenTokens.add(vid);
            orderedTokens.push(vid);
        }
    }

    if (!orderedTokens.length) return null;

    const arrayIndex = schema.type === "year-based"
        ? episode - 1
        : (episode - 1) % 20;

    if (arrayIndex >= orderedTokens.length) {
        log.warn(`Episode index ${arrayIndex} exceeds token array length ${orderedTokens.length}`);
        return null;
    }

    log.info(`Sequential match: index [${arrayIndex}] → video-${orderedTokens[arrayIndex]}`);
    return `video-${orderedTokens[arrayIndex]}`;
}
// ─────────────────────────────────────────────
// SSAI Ad Stripper — fetches a DASH .mpd manifest,

// Proxy cache: original mpd url → clean mpd string
const mpdProxyCache = new Map();

function getDirectChildrenByTag(el, tagName) {
    const results = [];
    const children = el.childNodes;
    for (let i = 0; i < children.length; i++) {
        const child = children.item(i);
        if (child.nodeType === 1 && (child.localName === tagName || child.tagName === tagName)) {
            results.push(child);
        }
    }
    return results;
}

function isAdPeriod(periodEl, mainCdnHost) {
    // Primary signal: Lura SSAI ad marker (urn:lura:ms5)
    // Scoped to direct children only to avoid xmldom traversing the whole doc.
    const eventStreams = getDirectChildrenByTag(periodEl, "EventStream");
    for (const es of eventStreams) {
        const scheme = es.getAttribute("schemeIdUri") || "";
        if (scheme === "urn:lura:ms5:20230106") return true;
    }

    // Secondary signal: explicitly named ad period IDs (non-Lura streams)
    const id = (periodEl.getAttribute("id") || "").toLowerCase();
    if (/\b(ad|preroll|midroll|postroll|slate|bumper|break)\b/.test(id)) return true;

    // Tertiary signal: different CDN host in BaseURL (non-Lura streams)
    if (mainCdnHost) {
        const baseUrls = getDirectChildrenByTag(periodEl, "BaseURL");
        for (const bu of baseUrls) {
            const href = bu.textContent || "";
            try {
                const host = new URL(href).hostname;
                if (host && host !== mainCdnHost) return true;
            } catch {}
        }
    }

    return false;
}

function parseDuration(iso) {
    // PT1M30S, PT30S, P0Y0M0DT0H0M30S, etc.
    if (!iso) return 0;
    const m = iso.match(/PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/);
    if (!m) return 0;
    return (parseFloat(m[1] || 0) * 3600) + (parseFloat(m[2] || 0) * 60) + parseFloat(m[3] || 0);
}

function stripAdsFromMpd(mpdText) {
    if (!DOMParser) return stripAdsFallback(mpdText);

    let doc;
    try {
        doc = new DOMParser().parseFromString(mpdText, "application/xml");
    } catch (e) {
        log.warn(`MPD parse error: ${e.message}`);
        return mpdText;
    }

    let mainCdnHost = null;
    const allBaseUrls = doc.getElementsByTagName("BaseURL");
    for (let i = 0; i < allBaseUrls.length; i++) {
        const href = (allBaseUrls.item(i).textContent || "").trim();
        try { mainCdnHost = new URL(href).hostname; break; } catch {}
    }

    const mpd = doc.documentElement;
    const allPeriods = getDirectChildrenByTag(mpd, "Period");

    const contentPeriods = [];
    for (const p of allPeriods) {
        if (isAdPeriod(p, mainCdnHost)) {
            p.parentNode.removeChild(p);
        } else {
            contentPeriods.push(p);
        }
    }

    const removed = allPeriods.length - contentPeriods.length;

    if (contentPeriods.length === 0) {
        log.warn("MPD ad stripper: no content periods survived — returning original");
        return mpdText;
    }

    // Leave all period start/duration/PTO values completely untouched.
    // ExoPlayer handles non-contiguous static multi-period DASH correctly.
    // Only remove the ad Period elements — nothing else.

    log.info(`MPD ad stripper: removed ${removed} ad period(s) of ${allPeriods.length} total, ${contentPeriods.length} content periods kept`);
    return new XMLSerializer().serializeToString(doc);
}


// Regex fallback if xmldom is unavailable
function stripAdsFallback(mpdText) {
    let removed = 0;
    // Remove <Period ...> blocks whose id attribute matches ad keywords
    const cleaned = mpdText.replace(
        /<Period\b([^>]*)>([\s\S]*?)<\/Period>/gi,
        (match, attrs) => {
            const id = (attrs.match(/\bid\s*=\s*["']([^"']*)["']/i)?.[1] || "").toLowerCase();
            if (/ad|preroll|midroll|postroll|slate|bumper/.test(id)) {
                removed++;
                return "";
            }
            // SCTE-35
            if (match.includes("scte35") || match.includes("urn:scte")) {
                removed++;
                return "";
            }
            return match;
        }
    );
    log.info(`MPD ad stripper (fallback): removed ${removed} ad period(s)`);
    return cleaned;
}

async function getCleanMpdUrl(originalMpdUrl, localBaseUrl) {
    try {
        const { data: mpdText } = await axios.get(originalMpdUrl, {
            timeout: CONFIG.REQUEST_TIMEOUT_MS,
            responseType: "text",
        });

        const clean = stripAdsFromMpd(mpdText);

        // Store under a hash of the full URL — no URL→key cache so every
        // play request always re-fetches and re-processes the fresh manifest.
        const { createHash } = await import("crypto");
        const key = createHash("sha1").update(originalMpdUrl).digest("base64url").slice(0, 32);
        mpdProxyCache.set(key, { mpdText: clean, originalUrl: originalMpdUrl });

        return `${localBaseUrl}/proxy/mpd/${key}`;
    } catch (err) {
        log.warn(`MPD fetch failed, using original URL: ${err.message}`);
        return originalMpdUrl;
    }
}
// ─────────────────────────────────────────────
// Lightweight stream resolver (no browser needed)
//
// ViX's Next.js server embeds a fresh, signed Lura JWT
// directly in the server-rendered video page as
// "videoToken":"eyJ...". That JWT is POSTed as
// `token=<jwt>` (application/x-www-form-urlencoded) to
// https://nxs.mp.lura.live/v1/play/{videoId}?guid={uuid}
// which returns a JSON player config whose
// content.media[] array contains the direct MPD/HLS URLs.
// ─────────────────────────────────────────────
async function getStreamUrlFromVix(videoPageUrl, numericVideoId) {
    try {
        const { data: html } = await axios.get(videoPageUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
            },
            timeout: CONFIG.REQUEST_TIMEOUT_MS,
            responseType: "text",
        });

        // Search for JWT token (header.payload.signature pattern)
        // Token is injected via JavaScript, so we search for the raw JWT pattern
        const jwtMatch = html.match(/eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+/);
        if (!jwtMatch) {
            log.warn(`No JWT token found in page: ${videoPageUrl}`);
            return null;
        }
        const luraToken = jwtMatch[0];

        const { randomUUID } = await import("crypto");
        const guid = randomUUID();
        const playUrl = `https://nxs.mp.lura.live/v1/play/${numericVideoId}?guid=${guid}`;

        let playerConfig;
        try {
            const res = await axios.post(
                playUrl,
                `token=${encodeURIComponent(luraToken)}`,
                {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                        "Accept": "*/*",
                        "Origin": "https://vix.com",
                        "Referer": "https://vix.com/",
                    },
                    timeout: CONFIG.REQUEST_TIMEOUT_MS,
                }
            );
            playerConfig = res.data;
        } catch (err) {
            log.warn(`Lura play API request failed: ${err.message}`);
            return null;
        }

        if (typeof playerConfig === "string") {
            try { playerConfig = JSON.parse(playerConfig); } catch {
                log.warn(`Lura play API returned non-JSON response for video ${numericVideoId}`);
                return null;
            }
        }

        const media = playerConfig?.content?.media || [];

        const dashEntry = media.find(m => m.type === "application/dash+xml");
        if (dashEntry?.url) {
            log.info(`Resolved MPD URL via lightweight API for video ${numericVideoId}`);
            return dashEntry.url;
        }

        const hlsEntry = media.find(m => m.type === "application/x-mpegURL");
        if (hlsEntry?.url) {
            log.info(`Resolved HLS URL via lightweight API for video ${numericVideoId}`);
            return hlsEntry.url;
        }

        log.warn(`No media URL found in Lura player config for video ${numericVideoId}`);
        return null;

    } catch (err) {
        log.warn(`getStreamUrlFromVix failed: ${err.message}`);
        return null;
    }
}

// ─────────────────────────────────────────────
// Warm up episode maps on startup for all
// shows that have a TVDB ID registered.
// Runs in the background — doesn't block serve.
// ─────────────────────────────────────────────
// Shows to skip during warmup (too large, or problematic)
// They'll still be mapped on-demand when requested
const SKIP_WARMUP = new Set([
    "tt1192302", // La rosa de Guadalupe (500+ episodes, takes too long)
]);

async function warmEpisodeMaps() {
    if (!CONFIG.TVDB_API_KEY) {
        log.warn("TVDB_API_KEY not set — skipping episode map warmup");
        return;
    }
    console.log("[TVDB] Warming episode maps for all registered shows…");
    for (const imdbId of Object.keys(LOCAL_TITLE_DB)) {
        if (SKIP_WARMUP.has(imdbId)) {
            log.info(`Skipping warmup for ${LOCAL_TITLE_DB[imdbId]} (on-demand only)`);
            continue;
        }
        buildEpisodeMap(imdbId).catch(err =>
            log.warn(`Warmup failed for ${imdbId}: ${err.message}`)
        );
    }
}
// ─────────────────────────────────────────────
// Stream handler
// ─────────────────────────────────────────────
builder.defineStreamHandler(async (args) => {
    const { type, id } = args;

    let imdbId        = id;
    let targetSeason  = 1;
    let targetEpisode = 1;

    if (type === "series") {
        const parts   = id.split(":");
        imdbId        = parts[0];
        targetSeason  = parseInt(parts[1]) || 1;
        targetEpisode = parseInt(parts[2]) || 1;
    }

    log.info(`Stream request: type=${type} id=${id}`);

    try {
        // 1 — Resolve title
        const meta = await getMediaMetadata(type, imdbId);
        if (!meta?.title) {
            log.warn(`No title resolved for ${imdbId}`);
            return { streams: [] };
        }

        log.info(`Resolved title: "${meta.title}" | S${targetSeason}E${targetEpisode}`);

        // 2 — Get ViX core ID
        const coreId = await getVixContentId(meta.title, type);
        if (!coreId) {
            log.warn(`No ViX core ID found for "${meta.title}"`);
            return { streams: [] };
        }

        let destinationUrl;
        let videoToken = null;

        if (type === "series") {
            // 3 — Detect season schema
            const schema = await detectSeasonSchema(coreId);

            // 4 — Translate TVDB coords → ViX coords via dynamic episode map
            const resolved = await resolveVixSeasonEpisode(
                imdbId, targetSeason, targetEpisode, coreId, schema
            );

            // Episode exists on TVDB but not on ViX — return nothing so Nuvio shows it as unavailable
            if (resolved.missing) {
                log.warn(`S${targetSeason}E${targetEpisode} is not available on ViX`);
                return { streams: [] };
            }

            const { vixSeason, vixEpisode } = resolved;

            // 5 — Extract video token
            videoToken = await extractVideoToken(coreId, vixSeason, vixEpisode, schema);

            if (videoToken) {
                destinationUrl = `https://vix.com/es-es/video/${videoToken}`;
            } else {
                let fallbackSeasonId;
                if (schema.type === "year-based") {
                    const year = schema.startYear + (vixSeason - 1);
                    fallbackSeasonId = `season:mcp:${coreId}_${year}`;
                } else {
                    const batch = Math.ceil(vixEpisode / 20);
                    fallbackSeasonId = `season:mcp:${coreId}_${vixSeason}:novelaSeasonId:${batch}`;
                }
                destinationUrl = `https://vix.com/es-es/detail/series-${coreId}` +
                    `?seasonId=${encodeURIComponent(fallbackSeasonId)}`;
                log.warn(`Token extraction failed. Fallback: ${destinationUrl}`);
            }
        } else {
            // Movie
            const variables = encodeURIComponent(JSON.stringify({
                searchQuery: meta.title,
                pagination: { first: 3, after: null },
            }));
            const searchUrl = `https://vix.com/api/capi?queryName=SearchV2DataQuery` +
                `&variables=${variables}&referralPath=&shouldSkipAvailabilityCheck=false`;

            try {
                const { data: raw } = await fetchWithRetry(searchUrl, {
                    headers: { "User-Agent": "Mozilla/5.0" },
                    timeout: CONFIG.REQUEST_TIMEOUT_MS,
                });
                const edges = (raw?.data || raw)?.searchVideosV2?.contentConnection?.edges || [];
                const movieNode = edges.find(e => {
                    const n = e.node || e;
                    return n.videoType !== "SERIES" && n.__typename !== "Series";
                });
                const node  = movieNode ? (movieNode.node || movieNode) : null;
                const vidId = node?.id?.match(/video:(?:mcp:)?(\d+)/)?.[1];
                if (vidId) videoToken = `video-${vidId}`;
                destinationUrl = vidId
                    ? `https://vix.com/es-es/video/video-${vidId}`
                    : `https://vix.com/es-es/detail/movie-${coreId}`;
            } catch {
                destinationUrl = `https://vix.com/es-es/detail/movie-${coreId}`;
            }
        }

        // 6 — Resolve stream URL via lightweight HTML+API resolver (no browser)
        let m3u8Url = null;
        if (videoToken) {
            const numericVideoId = videoToken.match(/\d+/)?.[0];
            if (numericVideoId) {
                m3u8Url = await getStreamUrlFromVix(destinationUrl, numericVideoId);
            } else {
                log.warn(`Could not extract numeric video ID from token "${videoToken}"`);
            }
        }

        // If we got a .mpd, strip SSAI ads and serve via local proxy
        if (m3u8Url && m3u8Url.includes(".mpd")) {
            const localBase = `http://${CONFIG.PROXY_HOST}:${CONFIG.PORT + 1}`;
            m3u8Url = await getCleanMpdUrl(m3u8Url, localBase);
            log.info(`Clean MPD proxy URL: ${m3u8Url}`);
        }

        log.info(`Dispatching: m3u8=${m3u8Url ? "found" : "none"} url=${destinationUrl}`);

        const stream = m3u8Url
            ? {
                name:  "Vix Hub Pro",
                title: type === "series" ? `S${targetSeason}E${targetEpisode} • ViX` : "Movie • ViX",
                url:   m3u8Url,
              }
            : {
                name:        "Vix Hub Pro",
                title:       type === "series" ? `Open S${targetSeason}E${targetEpisode} on ViX` : "Open on ViX",
                externalUrl: destinationUrl,
              };

        return { streams: [stream] };

    } catch (err) {
        log.error(`Stream handler crashed: ${err.message}`);
        return { streams: [] };
    }
});

// ─────────────────────────────────────────────
// Single-port server: proxy route + addon SDK
// on the same port so Nuvio can reach both.
// ─────────────────────────────────────────────
const addonInterface = builder.getInterface();
const app = express();

// /proxy/mpd/:key — serve ad-stripped DASH manifests
app.get("/proxy/mpd/:key", (req, res) => {
    const entry = mpdProxyCache.get(req.params.key);
    if (!entry) {
        res.status(404).send("MPD not found or expired");
        return;
    }
    res.setHeader("Content-Type", "application/dash+xml");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(entry.mpdText);
});

// Mount the addon SDK router if available, otherwise fall back to serveHTTP
if (typeof addonInterface.getRouter === "function") {
    app.use(addonInterface.getRouter());
    app.listen(CONFIG.PORT, () => {
        console.log(`Vix Hub Pro running on port ${CONFIG.PORT}`);
        console.log(`MPD proxy host: ${CONFIG.PROXY_HOST} (set PROXY_HOST env to override)`);
        console.log(`Manifest: http://localhost:${CONFIG.PORT}/manifest.json`);
        console.log(`MPD proxy: http://localhost:${CONFIG.PORT}/proxy/mpd/:key`);
        console.log(`Debug logging: ${CONFIG.DEBUG ? "ON" : "OFF (set DEBUG=true to enable)"}`);
    });
} else {
    // SDK doesn't expose getRouter — proxy runs on PORT+1
    const proxyServer = app.listen(CONFIG.PORT + 1, () => {
        console.log(`Vix Hub Pro running on port ${CONFIG.PORT}`);
        console.log(`MPD proxy host: ${CONFIG.PROXY_HOST} (set PROXY_HOST env to override)`);
        console.log(`Manifest: http://${CONFIG.PROXY_HOST}:${CONFIG.PORT}/manifest.json`);
        console.log(`MPD proxy: http://${CONFIG.PROXY_HOST}:${CONFIG.PORT + 1}/proxy/mpd/:key`);
        console.log(`Debug logging: ${CONFIG.DEBUG ? "ON" : "OFF (set DEBUG=true to enable)"}`);
    });
    proxyServer.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
            console.error(`[ERROR] Port ${CONFIG.PORT + 1} is already in use. Kill the existing process and restart.`);
            process.exit(1);
        }
        throw err;
    });
    serveHTTP(addonInterface, { port: CONFIG.PORT });
}

// Warm up episode maps in background after server starts
warmEpisodeMaps();