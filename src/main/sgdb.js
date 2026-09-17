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
    notes: String(d.notes || ''),
    url: String(d.url || ''),
    thumb: String(d.thumb || d.url || ''),
    upvotes: Number(d.upvotes || 0),
    downvotes: Number(d.downvotes || 0),
    author: String(author),
    get votes() { return this.upvotes - this.downvotes; },
  };
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
    let res;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          'User-Agent': 'LibShammes/0.9.0',
        },
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new SGDBError(`Network error: ${e.message || e}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) throw new SGDBError('Invalid SteamGridDB API key (401).', 401);
    if (res.status === 404) return [];
    if (res.status === 429) throw new SGDBError('SteamGridDB rate limit hit (429). Wait a minute and retry.', 429);
    if (!res.ok) throw new SGDBError(`SteamGridDB error ${res.status}.`, res.status);
    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new SGDBError('SteamGridDB returned invalid JSON.');
    }
    return (payload && typeof payload === 'object' && 'data' in payload) ? payload.data : payload;
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

  buildParams({ dimensions, types, nsfw, humor, limit = 50 } = {}) {
    const p = new URLSearchParams();
    if (dimensions) p.set('dimensions', dimensions);
    if (types) p.set('types', types);
    if (nsfw) p.set('nsfw', nsfw);
    if (humor) p.set('humor', humor);
    p.set('limit', String(limit));
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

  gridsVertical(gameId, o = {}) { return this._assets('grids', gameId, { ...o, dimensions: '600x900,660x930,342x482' }); }
  gridsWide(gameId, o = {}) { return this._assets('grids', gameId, { ...o, dimensions: '920x430,460x215' }); }
  heroes(gameId, o = {}) { return this._assets('heroes', gameId, { dimensions: '3840x1240,1920x620,1600x650', ...o }); }
  logos(gameId, o = {}) { return this._assets('logos', gameId, o); }
  icons(gameId, o = {}) { return this._assets('icons', gameId, o); }

  async downloadBytes(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'LibShammes/0.9.0' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new SGDBError(`Download failed (${res.status}): ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { BASE_URL, SGDBError, SGDBClient, parseGame, parseImage };
