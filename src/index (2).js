import {
  NSE_SYMBOLS_CACHE,
  determineExchange,
  formatCurrency,
  formatMarketCap,
  formatVolume,
  formatPercentage,
  formatRatio,
  searchInCache,
} from './format.js';
import { searchYahoo, searchYahooDirect, tryNseAutocomplete, getStockDetail, getQuoteBatch, getChartHistory } from './yahoo.js';

// Wide-open CORS: this API has no auth/session state to protect, and it's meant to be
// called directly from browser-based tools (dashboards, this repo's own client, etc.).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });

const timestamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function parseResFormat(url) {
  const res = (url.searchParams.get('res') || 'val').toLowerCase();
  if (res !== 'num' && res !== 'val') return null;
  return res;
}

async function handleSearch(url) {
  const query = (url.searchParams.get('q') || '').trim();
  if (!query) {
    return json(
      {
        status: 'error',
        message: 'Please provide a search query using ?q=SEARCH_TERM',
        example: '/search?q=indian oil',
      },
      400
    );
  }

  const cacheResults = searchInCache(query);
  const [nseResults, yahooResults, yahooDirectResults] = await Promise.all([
    tryNseAutocomplete(query),
    searchYahoo(query),
    searchYahooDirect(query),
  ]);

  const seen = new Set();
  const results = [];
  for (const r of [...nseResults, ...cacheResults, ...yahooResults, ...yahooDirectResults]) {
    if (r.symbol && !seen.has(r.symbol)) {
      seen.add(r.symbol);
      results.push(r);
    }
  }

  if (results.length === 0) {
    return json(
      {
        status: 'error',
        message: `No results found for: ${query}`,
        hint: 'Try searching with stock symbol (e.g., TCS, INFY, RELIANCE) or common company names',
        suggestions: [
          'For Indian Oil, try: IOC',
          'For Reliance, try: RELIANCE',
          'For TCS, try: TCS',
          'For Infosys, try: INFY',
        ],
      },
      404
    );
  }

  for (const r of results) {
    r.api_url = `/stock?symbol=${r.symbol}`;
    r.nse_url = `/stock?symbol=${r.symbol}.NS`;
    r.bse_url = `/stock?symbol=${r.symbol}.BO`;
  }

  return json({
    status: 'success',
    query,
    total_results: results.length,
    results,
    note: 'Add .NS for NSE or .BO for BSE to the symbol. Default is NSE.',
    timestamp: timestamp(),
  });
}

async function handleStock(url) {
  const symbolInput = (url.searchParams.get('symbol') || '').toUpperCase();
  if (!symbolInput) {
    return json(
      {
        status: 'error',
        message: 'Please provide a stock symbol using ?symbol=STOCKNAME',
        hint: 'Use /search?q=company_name to find the correct symbol',
        examples: ['/stock?symbol=ITC (NSE - default)', '/stock?symbol=ITC.NS (NSE - explicit)', '/stock?symbol=ITC.BO (BSE)'],
      },
      400
    );
  }

  const resFormat = parseResFormat(url);
  if (resFormat === null) {
    return json(
      {
        status: 'error',
        message: 'Invalid response type. Use res=num for numbers only or res=val for values with units',
        examples: ['/stock?symbol=ITC&res=num', '/stock?symbol=ITC&res=val'],
      },
      400
    );
  }
  const withUnits = resFormat === 'val';

  const [cleanSymbol, exchangeSuffix] = determineExchange(symbolInput);
  const tickerSymbol = `${cleanSymbol}${exchangeSuffix}`;
  const exchangeName = exchangeSuffix === '.NS' ? 'NSE' : 'BSE';

  const detail = await getStockDetail(tickerSymbol);
  if (!detail) {
    return json(
      {
        status: 'error',
        message: `No data found for symbol: ${cleanSymbol} on ${exchangeName}. Stock may not exist or market is closed.`,
        hint: exchangeName === 'NSE' ? `Try the other exchange: ${cleanSymbol}.BO` : `Try the other exchange: ${cleanSymbol}.NS`,
        note: 'Markets are closed on weekends and holidays',
      },
      404
    );
  }

  const response = {
    status: 'success',
    symbol: cleanSymbol,
    exchange: exchangeName,
    ticker: tickerSymbol,
    response_format: withUnits ? 'values_with_units' : 'numeric_only',
    data: {
      company_name: detail.companyName,
      last_price: formatCurrency(detail.lastPrice, withUnits),
      change: formatCurrency(detail.change, withUnits),
      percent_change: formatPercentage(detail.percentChange, withUnits),
      previous_close: formatCurrency(detail.previousClose, withUnits),
      open: formatCurrency(detail.open, withUnits),
      day_high: formatCurrency(detail.dayHigh, withUnits),
      day_low: formatCurrency(detail.dayLow, withUnits),
      year_high: formatCurrency(detail.yearHigh, withUnits),
      year_low: formatCurrency(detail.yearLow, withUnits),
      volume: formatVolume(detail.volume, withUnits),
      market_cap: formatMarketCap(detail.marketCap, withUnits),
      pe_ratio: formatRatio(detail.peRatio, withUnits),
      dividend_yield: formatPercentage(detail.dividendYield, withUnits),
      book_value: formatCurrency(detail.bookValue, withUnits),
      earnings_per_share: formatCurrency(detail.eps, withUnits),
      sector: detail.sector,
      industry: detail.industry,
      currency: detail.currency,
      last_update: detail.lastUpdateEpoch ? new Date(detail.lastUpdateEpoch * 1000).toISOString().slice(0, 10) : 'N/A',
      timestamp: timestamp(),
    },
    alternate_exchange: {
      exchange: exchangeName === 'NSE' ? 'BSE' : 'NSE',
      ticker: exchangeName === 'NSE' ? `${cleanSymbol}.BO` : `${cleanSymbol}.NS`,
      api_url: exchangeName === 'NSE' ? `/stock?symbol=${cleanSymbol}.BO` : `/stock?symbol=${cleanSymbol}.NS`,
    },
  };

  return json(response);
}

async function handleStockList(url) {
  const symbolsParam = url.searchParams.get('symbols') || '';
  if (!symbolsParam) {
    return json(
      {
        status: 'error',
        message: 'Please provide stock symbols using ?symbols=STOCK1,STOCK2',
        examples: ['/stock/list?symbols=ITC,TCS,INFY (default NSE)', '/stock/list?symbols=ITC.NS,TCS.BO,INFY (mixed exchanges)'],
      },
      400
    );
  }

  const resFormat = parseResFormat(url);
  if (resFormat === null) {
    return json(
      {
        status: 'error',
        message: 'Invalid response type. Use res=num for numbers only or res=val for values with units',
      },
      400
    );
  }
  const withUnits = resFormat === 'val';

  const parsed = symbolsParam.split(',').map((s) => {
    const [cleanSymbol, exchangeSuffix] = determineExchange(s.trim());
    return {
      cleanSymbol,
      exchangeName: exchangeSuffix === '.NS' ? 'NSE' : 'BSE',
      tickerSymbol: `${cleanSymbol}${exchangeSuffix}`,
    };
  });

  const quotes = await getQuoteBatch(parsed.map((p) => p.tickerSymbol));

  const results = parsed.map(({ cleanSymbol, exchangeName, tickerSymbol }) => {
    const q = quotes[tickerSymbol];
    if (!q) {
      return { symbol: cleanSymbol, exchange: exchangeName, ticker: tickerSymbol, error: 'No data available' };
    }
    return {
      symbol: cleanSymbol,
      exchange: exchangeName,
      ticker: tickerSymbol,
      company_name: q.companyName,
      last_price: formatCurrency(q.lastPrice, withUnits),
      change: formatCurrency(q.change, withUnits),
      percent_change: formatPercentage(q.percentChange, withUnits),
      volume: formatVolume(q.volume, withUnits),
      market_cap: formatMarketCap(q.marketCap, withUnits),
      pe_ratio: formatRatio(q.peRatio, withUnits),
    };
  });

  return json({
    status: 'success',
    response_format: withUnits ? 'values_with_units' : 'numeric_only',
    count: results.length,
    stocks: results,
    timestamp: timestamp(),
  });
}

async function handleHistory(url) {
  const symbolInput = (url.searchParams.get('symbol') || '').toUpperCase();
  if (!symbolInput) {
    return json(
      {
        status: 'error',
        message: 'Please provide a stock symbol using ?symbol=STOCKNAME',
        examples: ['/history?symbol=RELIANCE&range=1y&interval=1d', '/history?symbol=TCS&range=5d&interval=15m'],
      },
      400
    );
  }
  const range = url.searchParams.get('range') || '1y';
  const interval = url.searchParams.get('interval') || '1d';
  const [cleanSymbol, exchangeSuffix] = determineExchange(symbolInput);
  const tickerSymbol = `${cleanSymbol}${exchangeSuffix}`;

  const history = await getChartHistory(tickerSymbol, range, interval);
  if (!history || history.closes.length === 0) {
    return json(
      { status: 'error', message: `No historical data found for ${cleanSymbol} (${range}/${interval})` },
      404
    );
  }

  return json({
    status: 'success',
    symbol: cleanSymbol,
    ticker: tickerSymbol,
    range,
    interval,
    count: history.closes.length,
    timestamps: history.timestamps,
    closes: history.closes,
    highs: history.highs,
    lows: history.lows,
    volumes: history.volumes,
    timestamp: timestamp(),
  });
}

// Full list of NSE-listed equities, straight from NSE's own published master file
// (not a live quote endpoint — just the static symbol/company/ISIN list they publish).
// Cached in module scope so it survives across requests within the same warm isolate.
let universeCache = { data: null, fetchedAt: 0 };
const UNIVERSE_URL = 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';
const UNIVERSE_TTL_MS = 12 * 60 * 60 * 1000; // 12h — this list changes rarely (new listings/delistings only)

function parseEquityCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map((h) => h.trim().toUpperCase());
  const symIdx = header.indexOf('SYMBOL');
  const nameIdx = header.indexOf('NAME OF COMPANY');
  const seriesIdx = header.indexOf(' SERIES') !== -1 ? header.indexOf(' SERIES') : header.indexOf('SERIES');
  const isinIdx = header.findIndex((h) => h.includes('ISIN'));
  const dateIdx = header.findIndex((h) => h.includes('DATE OF LISTING'));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 2) continue;
    const symbol = (cols[symIdx] || '').trim();
    if (!symbol) continue;
    rows.push({
      symbol,
      company_name: (cols[nameIdx] || '').trim(),
      series: (cols[seriesIdx] || '').trim(),
      isin: isinIdx !== -1 ? (cols[isinIdx] || '').trim() : null,
      listing_date: dateIdx !== -1 ? (cols[dateIdx] || '').trim() : null,
    });
  }
  return rows;
}

async function handleUniverse(url) {
  const seriesFilter = (url.searchParams.get('series') || 'EQ').toUpperCase();
  const now = Date.now();
  if (!universeCache.data || now - universeCache.fetchedAt > UNIVERSE_TTL_MS) {
    try {
      const res = await fetch(UNIVERSE_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      universeCache = { data: parseEquityCsv(text), fetchedAt: now };
    } catch (err) {
      if (!universeCache.data) {
        return json({ status: 'error', message: `Could not fetch NSE's company list: ${err.message}` }, 502);
      }
      // fall through and serve stale cache rather than fail outright
    }
  }
  const all = universeCache.data;
  const filtered = seriesFilter === 'ALL' ? all : all.filter((r) => r.series === seriesFilter);
  return json({
    status: 'success',
    series_filter: seriesFilter,
    total: filtered.length,
    cached_at: new Date(universeCache.fetchedAt).toISOString(),
    companies: filtered,
    note: 'Symbol/company/ISIN list from NSE\u2019s own published EQUITY_L.csv \u2014 static reference data, not live prices. Use /stock/list for live quotes.',
  });
}

function handleSymbols() {
  const symbolsList = Object.entries(NSE_SYMBOLS_CACHE).map(([company, symbol]) => ({
    search_term: company,
    symbol,
    nse_ticker: `${symbol}.NS`,
    bse_ticker: `${symbol}.BO`,
    api_url_nse: `/stock?symbol=${symbol}.NS`,
    api_url_bse: `/stock?symbol=${symbol}.BO`,
  }));

  return json({
    status: 'success',
    total_symbols: symbolsList.length,
    symbols: symbolsList,
    note: 'Most stocks are available on both NSE (.NS) and BSE (.BO). Default is NSE.',
  });
}

// Generic secure proxy to stock.indianapi.in. The API key lives only as a Worker secret
// (set via `wrangler secret put INDIAN_API_KEY` or the dashboard) and is never sent to
// the browser. The browser calls /india/<path> on THIS worker; this worker adds the key
// and forwards to the real service.
const INDIAN_API_BASE = 'https://stock.indianapi.in';

async function handleIndiaProxy(url, env) {
  if (!env.INDIAN_API_KEY) {
    return json(
      {
        status: 'error',
        message:
          'INDIAN_API_KEY secret is not set on this Worker. Run `wrangler secret put INDIAN_API_KEY` (or add it in the Cloudflare dashboard under Settings > Variables and Secrets) with a key from indianapi.in.',
      },
      501
    );
  }
  const upstreamPath = url.pathname.replace(/^\/india/, '') || '/';
  const upstreamUrl = INDIAN_API_BASE + upstreamPath + url.search;
  let res;
  try {
    res = await fetch(upstreamUrl, { headers: { 'X-API-Key': env.INDIAN_API_KEY } });
  } catch (err) {
    return json({ status: 'error', message: `Could not reach Indian API: ${err.message}` }, 502);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ status: 'error', message: 'Non-JSON response from Indian API', raw: text.slice(0, 300) }, 502);
  }
  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

// Second secure proxy, same pattern as /india: keeps the Parse API key server-side only.
// Parse's NSE India API (parse.bot marketplace) — option chains, market status,
// gainers/losers, and other endpoints Yahoo/indianapi.in don't cover well.
const PARSE_API_BASE = 'https://api.parse.bot/scraper/d621017b-ba03-43b8-816b-e5167cb6ec16';

async function handleParseProxy(url, env) {
  if (!env.PARSE_API_KEY) {
    return json(
      {
        status: 'error',
        message:
          'PARSE_API_KEY secret is not set on this Worker. Run `wrangler secret put PARSE_API_KEY` (or add it in the Cloudflare dashboard) with a key from parse.bot.',
      },
      501
    );
  }
  const upstreamPath = url.pathname.replace(/^\/parse/, '') || '/';
  const upstreamUrl = PARSE_API_BASE + upstreamPath + url.search;
  let res;
  try {
    res = await fetch(upstreamUrl, { headers: { 'X-API-Key': env.PARSE_API_KEY } });
  } catch (err) {
    return json({ status: 'error', message: `Could not reach Parse API: ${err.message}` }, 502);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ status: 'error', message: 'Non-JSON response from Parse API', raw: text.slice(0, 300) }, 502);
  }
  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function handleHome() {
  return json({
    message: 'NSE/BSE Stock Price API with Smart Search & Flexible Output',
    version: '3.0',
    status: 'operational',
    features: [
      'Support for both NSE and BSE exchanges',
      'Automatic exchange detection from symbol suffix',
      'Multi-source search (Local Cache + Yahoo Finance)',
      'Real-time stock prices via Yahoo Finance',
      '30+ pre-cached popular stock symbols',
      'Flexible output: Simple numbers OR Values with units',
      'Smart number formatting for readability',
    ],
    exchanges: {
      NSE: { description: 'National Stock Exchange', suffix: '.NS', example: 'ITC.NS, RELIANCE.NS', default: true },
      BSE: { description: 'Bombay Stock Exchange', suffix: '.BO', example: 'ITC.BO, RELIANCE.BO', default: false },
    },
    endpoints: {
      '/search': { description: 'Search for stocks by company name', method: 'GET', parameters: 'q=SEARCH_TERM' },
      '/stock': { description: 'Get single stock details', method: 'GET', parameters: 'symbol=STOCK_SYMBOL, res=num|val (optional)' },
      '/stock/list': { description: 'Get multiple stock details (batched, no sector field)', method: 'GET', parameters: 'symbols=STOCK1,STOCK2, res=num|val (optional)' },
      '/symbols': { description: 'List all available cached symbols', method: 'GET' },
      '/universe': {
        description: 'Full list of NSE-listed companies (symbol, name, ISIN) from NSE\u2019s own published EQUITY_L.csv. Reference data, not live prices.',
        method: 'GET',
        parameters: 'series=EQ (default, main board) | ALL',
      },
      '/india/*': {
        description:
          'Secure proxy to stock.indianapi.in (search, trending, ipo, news, mutual_funds, commodities, historical_data, corporate_actions, and more). Requires the INDIAN_API_KEY secret to be set on this Worker. Call it as /india/<path-from-indianapi-docs>, e.g. /india/ipo, /india/trending, /india/stock?name=Reliance.',
        method: 'GET',
      },
      '/parse/*': {
        description:
          'Secure proxy to Parse\u2019s NSE India API (option chains, market status, gainers/losers, 52-week movers, financials, corporate announcements, and more). Requires the PARSE_API_KEY secret to be set on this Worker. Call it as /parse/<endpoint>, e.g. /parse/get_market_status, /parse/get_option_chain?symbol=RELIANCE&type=Equity.',
        method: 'GET',
      },
    },
    response_formats: {
      'res=num': 'Simple numeric values',
      'res=val': 'Values with units',
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/india/') || url.pathname === '/india') {
        return await handleIndiaProxy(url, env);
      }
      if (url.pathname.startsWith('/parse/') || url.pathname === '/parse') {
        return await handleParseProxy(url, env);
      }
      switch (url.pathname) {
        case '/':
          return handleHome();
        case '/search':
          return await handleSearch(url);
        case '/stock':
          return await handleStock(url);
        case '/stock/list':
          return await handleStockList(url);
        case '/history':
          return await handleHistory(url);
        case '/symbols':
          return handleSymbols();
        case '/universe':
          return await handleUniverse(url);
        default:
          return json({ status: 'error', message: 'Not found' }, 404);
      }
    } catch (err) {
      return json({ status: 'error', message: `Error: ${err.message}` }, 500);
    }
  },
};
