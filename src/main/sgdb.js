'use strict';
/* gets game matches and artwork from SGDB */
const BASE_URL = 'https://www.steamgriddb.com/api/v2';

class SGDBError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'SGDBError';
    this.status = status;
  }
}

function parseGame(d) {
  return {
    id: Number(d.id || 0),
    name: String(d.name || ''),
    types: [...(d.types || [])],
    verified: Boolean(d.verified || false),
  };
}

function parseImage(d) {
  const author = (d.author && d.author.name) || '';
  return {
    id: Number(d.id || 0),
    score: Number(d.score || 0),
    style: String(d.style || ''),
    width: Number(d.width || 0),
    height: Number(d.height || 0),
    nsfw: Boolean(d.nsfw),
    humor: Boolean(d.humor),
    epilepsy: Boolean(d.epilepsy),
    notes: String(d.notes || ''),
    url: String(d.url || ''),
    thumb: String(d.thumb || d.url || ''),
    upvotes: Number(d.upvotes || 0),
    downvotes: Number(d.downvotes || 0),
    author: String(author),
    get votes() { return this.upvotes - this.downvotes; },
  };
}

function chooseArtwork(items, filters = {}, random = Math.random) {
  if (!items.length) return null;
  const tagged = filters.untagged === false || filters.nsfw || filters.humor;
  if (!tagged) return items[0];
  const preferred = items.filter(image => filters.nsfw && image.nsfw || filters.humor && image.humor);
  const pool = (preferred.length ? preferred : items).slice(0, 10);
  return pool[Math.floor(random() * pool.length)];
}

function officialArtworkUrls(appid, kind, metadata = {}) {
  const key = { wide: 'header_image', grid: 'library_capsule', hero: 'library_hero', logo: 'library_logo', icon: 'icon' }[kind];
  const full = metadata[`${key}_full`];
  const urls = [metadata[key], ...[full?.image2x, full?.image || full].flatMap(map =>
    typeof map === 'string' ? [map] : [map?.english, ...Object.values(map || {})])];
  const name = { wide: 'header.jpg', grid: 'library_600x900.jpg', hero: 'library_hero.jpg', logo: 'logo.png' }[kind];
  if (kind === 'icon' && /^[a-f0-9]{40}$/i.test(metadata.icon || '')) {
    urls.push(`https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appid}/${metadata.icon}.jpg`);
  } else if (name) urls.push(`https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/${name}`);
  return [...new Set(urls.filter(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && url.hostname.endsWith('.steamstatic.com'); }
    catch { return false; }
  }))];
}

class SGDBClient {
  constructor(apiKey, timeoutMs = 20000) {
    this.apiKey = String(apiKey || '').trim();
    this.timeoutMs = timeoutMs;
  }

  async _getJson(path) {
    if (!this.apiKey) {
      throw new SGDBError('SteamGridDB API key is missing. Get one at steamgriddb.com/profile/preferences/api');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      let res;
      try {
        res = await fetch(`${BASE_URL}${path}`, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
            'User-Agent': 'LibShammes/0.9.1',
          },
          signal: ctrl.signal,
        });
      } catch (e) {
        throw new SGDBError(`Network error: ${e.message || e}`);
      }
      if (res.status === 401) throw new SGDBError('Invalid SteamGridDB API key (401).', 401);
      if (res.status === 404) return [];
      if (res.status === 429) throw new SGDBError('SteamGridDB rate limit hit (429). Wait a minute and retry.', 429);
      if (!res.ok) throw new SGDBError(`SteamGridDB error ${res.status}.`, res.status);
      let payload;
      try {
        payload = await res.json();
      } catch (e) {
        if (ctrl.signal.aborted) throw new SGDBError(`Network error: ${e.message || e}`);
        throw new SGDBError('SteamGridDB returned invalid JSON.');
      }
      return (payload && typeof payload === 'object' && 'data' in payload) ? payload.data : payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async searchGame(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const data = await this._getJson(`/search/autocomplete/${encodeURIComponent(q)}`);
    if (!Array.isArray(data)) return [];
    return data.filter((d) => d && typeof d === 'object').map(parseGame);
  }

  /** Exact Steam AppID lookup. Returns null on lookup failure so callers can try title search. */
  async gameBySteamAppid(appid) {
    let data;
    try {
      data = await this._getJson(`/games/steam/${Number(appid)}`);
    } catch {
      return null;
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) return parseGame(data);
    if (Array.isArray(data) && data.length && typeof data[0] === 'object') return parseGame(data[0]);
    return null;
  }

  async steamMetadata(appid) {
    const game = await this.gameBySteamAppid(appid);
    if (game) {
      const data = await this._getJson(`/games/id/${game.id}?platformdata=steam`);
      const entry = data?.external_platform_data?.steam?.find((item) => String(item.id) === String(appid));
      if (entry?.metadata) return entry.metadata;
    }
    throw new SGDBError('Could not check stock Steam artwork.');
  }

  buildParams({ dimensions, types, nsfw, humor, epilepsy, oneoftag, styles, mimes, limit = 50, page = 0 } = {}) {
    const p = new URLSearchParams();
    if (dimensions) p.set('dimensions', dimensions);
    if (types) p.set('types', types);
    if (nsfw) p.set('nsfw', nsfw);
    if (humor) p.set('humor', humor);
    if (epilepsy) p.set('epilepsy', epilepsy);
    if (oneoftag) p.set('oneoftag', oneoftag);
    if (styles) p.set('styles', styles);
    if (mimes) p.set('mimes', mimes);
    p.set('limit', String(limit));
    p.set('page', String(page));
    return p.toString();
  }

  async _assets(kind, gameId, opts) {
    const q = this.buildParams(opts);
    const data = await this._getJson(`/${kind}/game/${Number(gameId)}${q ? `?${q}` : ''}`);
    if (!Array.isArray(data)) return [];
    return data
      .filter((d) => d && d.url)
      .map(parseImage)
      .sort((a, b) => (b.score - a.score) || (b.votes - a.votes));
  }

  gridsVertical(gameId, o = {}) { return this._assets('grids', gameId, { dimensions: '600x900,660x930,342x482', ...o }); }
  gridsWide(gameId, o = {}) { return this._assets('grids', gameId, { dimensions: '920x430,460x215', ...o }); }
  heroes(gameId, o = {}) { return this._assets('heroes', gameId, { dimensions: '3840x1240,1920x620,1600x650', ...o }); }
  logos(gameId, o = {}) { return this._assets('logos', gameId, o); }
  icons(gameId, o = {}) { return this._assets('icons', gameId, o); }

  async downloadBytes(url, maxBytes = Infinity) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'LibShammes/0.9.1' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new SGDBError(`Download failed (${res.status}): ${url}`);
      if (Number.isFinite(maxBytes)) {
        const chunks = [];
        let length = 0;
        for await (const chunk of res.body) {
          length += chunk.length;
          if (length > maxBytes) throw new SGDBError('Image exceeds the download size limit.');
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      }
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { BASE_URL, SGDBError, SGDBClient, parseGame, parseImage, chooseArtwork, officialArtworkUrls };
