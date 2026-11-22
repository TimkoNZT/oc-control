#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const VERSION = '2.5.3';
const META_KEY = 'ai.opencode/sessionID';
const DB_PATH =
  process.env.OC_DB ?? path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

function openDb(opts) {
  if (!fs.existsSync(DB_PATH)) throw new Error(`база OpenCode не найдена: ${DB_PATH}`);
  const d = opts ? new DatabaseSync(DB_PATH, opts) : new DatabaseSync(DB_PATH);
  d.exec('PRAGMA busy_timeout=10000');
  return d;
}

function deleteTodos(ids, errors = []) {
  if (!ids.length) return errors;
  try {
    const d = openDb({ enableForeignKeyConstraints: false });
    try {
      d.exec('BEGIN IMMEDIATE');
      try {
        const stmt = d.prepare('delete from todo where session_id = ?');
        for (const id of ids) stmt.run(id);
        d.exec('COMMIT');
      } catch (e) {
        d.exec('ROLLBACK');
        throw e;
      }
    } finally {
      d.close();
    }
  } catch (e) {
    errors.push(`todo: ${e.message}`);
  }
  return errors;
}

function serviceFileCandidates() {
  const out = [];
  if (process.env.OC_SERVICE_FILE) out.push(process.env.OC_SERVICE_FILE);
  if (process.env.XDG_STATE_HOME) {
    out.push(path.join(process.env.XDG_STATE_HOME, 'opencode', 'service.json'));
  }
  out.push(path.join(os.homedir(), '.local', 'state', 'opencode', 'service.json'));
  if (process.env.LOCALAPPDATA) {
    out.push(path.join(process.env.LOCALAPPDATA, 'opencode', 'service.json'));
  }
  return out;
}

let cached = null;

function connection() {
  if (cached) return cached;
  if (process.env.OC_URL) {
    cached = { url: process.env.OC_URL.replace(/\/$/, ''), password: process.env.OC_PASSWORD ?? null, pid: null };
    return cached;
  }
  for (const file of serviceFileCandidates()) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw?.url) {
        cached = { url: String(raw.url).replace(/\/$/, ''), password: raw.password ?? null, pid: raw.pid ?? null, file };
        return cached;
      }
    } catch {}
  }
  throw new Error(
    'не найден service.json с адресом сервера OpenCode V2. Задайте OC_URL (и при необходимости OC_PASSWORD).',
  );
}

function authHeaders() {
  const c = connection();
  if (!c.password) return {};
  return { authorization: 'Basic ' + Buffer.from(`opencode:${c.password}`).toString('base64') };
}

async function apiOnce(pathname, opts = {}, timeoutMs = 15000) {
  const c = connection();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(c.url + pathname, {
      ...opts,
      signal: ac.signal,
      headers: { ...authHeaders(), ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const raw = data?.message ?? data?.error ?? (typeof data === 'string' ? data : JSON.stringify(data));
      const msg = String(raw ?? res.statusText).slice(0, 300);
      const err = new Error(`${res.status} ${pathname}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`timeout ${timeoutMs}ms: ${pathname}`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function api(pathname, opts = {}, timeoutMs = 15000) {
  try {
    return await apiOnce(pathname, opts, timeoutMs);
  } catch (e) {
    const code = e?.cause?.code ?? e?.code;
    const retry =
      cached &&
      (e.status === 401 ||
        e.status === 403 ||
        code === 'ECONNREFUSED' ||
        code === 'ECONNRESET' ||
        /fetch failed/i.test(e.message));
    if (!retry) throw e;
    cached = null;
    return await apiOnce(pathname, opts, timeoutMs);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const normalizeDir = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
const dirKey = (p) => (process.platform === 'win32' ? normalizeDir(p).toLowerCase() : normalizeDir(p));

function mapDir(oldDir, newDir, dir) {
  const oldNorm = normalizeDir(oldDir);
  const newNorm = normalizeDir(newDir);
  const d = normalizeDir(dir);
  if (!oldNorm || !d) return null;
  const oldKey = dirKey(oldNorm);
  const newKey = dirKey(newNorm);
  const dKey = dirKey(d);
  if (dKey === oldKey) return newNorm;
  if (!dKey.startsWith(oldKey + '/')) return null;
  if (newKey !== oldKey && newKey.startsWith(oldKey + '/')) {
    if (dKey === newKey || dKey.startsWith(newKey + '/')) return d;
  }
  return newNorm + '/' + d.slice(oldNorm.length + 1);
}

function sessionPath(dir) {
  const d = normalizeDir(dir);
  const m = /^[A-Za-z]:\/(.*)$/.exec(d);
  if (m) return m[1];
  if (d.startsWith('/')) return d.slice(1);
  return null;
}

function detectVcsRoot(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git')) || fs.existsSync(path.join(cur, '.hg'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function isBusy(session) {
  const t = session?.time ?? {};
  return Number(t.busy ?? 0) > Number(t.idle ?? 0);
}

function sessionBrief(s) {
  return {
    id: s.id,
    title: s.title,
    agent: s.agent,
    model: s.model ?? null,
    parentID: s.parentID ?? null,
    outcome: s.outcome ?? s.idleOutcome ?? null,
    busy: isBusy(s),
    directory: s.location?.directory ?? s.directory ?? null,
    tokens: s.tokens ? { input: s.tokens.input, output: s.tokens.output } : null,
    elapsedSec: s.time?.created ? Math.round((Date.now() - s.time.created) / 1000) : null,
  };
}

async function getSession(sessionId) {
  const r = await api(`/api/session/${encodeURIComponent(sessionId)}`);
  return r?.data ?? r;
}

function messageText(m) {
  if (!m || typeof m !== 'object') return '';
  if (typeof m.text === 'string' && m.text) return m.text;
  if (m.type === 'assistant' && Array.isArray(m.content)) {
    return m.content
      .map((p) => {
        if (!p || typeof p !== 'object') return '';
        if (p.type === 'text') return p.text ?? '';
        if (p.type === 'reasoning') return '';
        if (p.type === 'tool') return `[tool ${p.name ?? '?'} ${p.state?.status ?? ''}]`.trim();
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  if (m.type === 'idle') return `[idle ${m.outcome ?? ''}]`.trim();
  if (m.type === 'compaction') return `[compaction ${m.status ?? ''}]`.trim();
  return `[${m.type ?? 'message'}]`;
}

async function lastMessages(sessionId, limit = 3, order = 'desc') {
  const r = await api(`/api/session/${encodeURIComponent(sessionId)}/message?limit=${limit}&order=${order}`);
  const list = Array.isArray(r?.data) ? r.data : [];
  return list.map((m) => ({
    type: m.type,
    at: m.time?.created ? new Date(m.time.created).toISOString() : null,
    text: messageText(m).replace(/\s+/g, ' ').trim().slice(0, 400),
    model: m.model ?? null,
    tokens: m.tokens ?? null,
  }));
}

async function getActiveSessionIds() {
  try {
    const r = await api('/api/session/active');
    const data = r?.data ?? r;
    if (!data || typeof data !== 'object') return null;
    return new Set(Object.keys(data));
  } catch {
    return null;
  }
}

function parseModelRef(model) {
  if (typeof model === 'string') {
    const m = /^([^/:]+)\/([^:]+)(?::(.+))?$/.exec(model.trim());
    if (!m) throw new Error('model: ожидается "providerID/modelID" или объект {providerID, id, variant?}');
    return { providerID: m[1], id: m[2], ...(m[3] ? { variant: m[3] } : {}) };
  }
  if (model && typeof model === 'object') {
    if (!model.providerID || !model.id) throw new Error('model: укажите providerID и id');
    return {
      providerID: String(model.providerID),
      id: String(model.id),
      ...(model.variant ? { variant: String(model.variant) } : {}),
    };
  }
  throw new Error('model: ожидается "providerID/modelID" или объект {providerID, id, variant?}');
}

let modelIndexCache = { at: 0, map: new Map() };

async function getModelIndex() {
  if (modelIndexCache.map.size && Date.now() - modelIndexCache.at < 60_000) return modelIndexCache.map;
  try {
    const r = await api('/api/model');
    const list = Array.isArray(r?.data) ? r.data : Array.isArray(r) ? r : [];
    const map = new Map();
    for (const m of list) map.set(`${m.providerID}|${m.modelID ?? m.id}`, m);
    modelIndexCache = { at: Date.now(), map };
    return map;
  } catch {
    return modelIndexCache.map;
  }
}

function contextFor(session, models, last, stale = false) {
  const ref = last?.model ?? session?.model ?? null;
  const model = ref ? models.get(`${ref.providerID}|${ref.id}`) : null;
  const limit = model?.limit?.context ?? null;
  const outputLimit = model?.limit?.output ?? null;
  let used = null;
  let stepAt = null;
  if (last?.tokens) {
    const t = last.tokens;
    used =
      (t.input ?? 0) +
      (t.cache?.read ?? 0) +
      (t.cache?.write ?? 0) +
      (t.output ?? 0) +
      (t.reasoning ?? 0);
    stepAt = last.at ?? null;
  }
  return {
    model: ref,
    name: model?.name ?? null,
    limit,
    outputLimit,
    used,
    remaining: limit != null && used != null ? Math.max(0, limit - used) : null,
    percent: limit && used != null ? Math.round((used / limit) * 1000) / 10 : null,
    stepAt,
    stale: Boolean(stale),
  };
}

function contextFromRecent(session, models, recent) {
  const latestAssistant = recent.find((m) => m.type === 'assistant');
  const last = recent.find((m) => m.type === 'assistant' && m.tokens) ?? null;
  return contextFor(session, models, last, Boolean(latestAssistant && !latestAssistant.tokens));
}

async function contextFromMessages(session, models) {
  try {
    const recent = await lastMessages(session.id, 10);
    return contextFromRecent(session, models, recent);
  } catch {
    return contextFor(session, models, null, true);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function allSessions(pageSize = 500) {
  const out = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 100; page += 1) {
    const query = `/api/session?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await api(query);
    const list = Array.isArray(r?.data) ? r.data : [];
    for (const s of list) {
      if (s?.id && !seen.has(s.id)) {
        seen.add(s.id);
        out.push(s);
      }
    }
    const next = r?.cursor?.next;
    if (!next || list.length === 0 || list.length < pageSize) break;
    cursor = next;
  }
  return out;
}

async function childSessions(parentId) {
  const list = await allSessions();
  return list.filter((s) => s.parentID === parentId);
}

async function snapshot(sessionIds, includeMessages = 3, full = false, withContext = true) {
  const out = [];
  const models = withContext ? await getModelIndex() : null;
  const activeIds = await getActiveSessionIds();
  for (const id of sessionIds) {
    try {
      const s = await getSession(id);
      const item = sessionBrief(s);
      item.active = activeIds ? activeIds.has(id) : item.busy;
      if (full) {
        item.time = s.time;
        item.cost = s.cost;
        item.tokens = s.tokens;
      }
      const needMessages = withContext ? Math.max(includeMessages, 10) : includeMessages;
      const recent = needMessages > 0 ? await lastMessages(id, needMessages) : [];
      if (withContext) item.context = contextFromRecent(item, models, recent);
      if (includeMessages > 0) item.last = recent.slice(0, includeMessages);
      out.push(item);
    } catch (e) {
      out.push({ id, error: e.message });
    }
  }
  return out;
}

async function waitIdle(sessionIds, timeoutSec = 120, pollSec = 5, includeMessages = 3) {
  const started = Date.now();
  let idleRounds = 0;
  let last = [];
  for (;;) {
    last = await snapshot(sessionIds, includeMessages);
    const busy = last.filter((x) => x.busy);
    const errors = last.filter((x) => x.error);
    if (busy.length === 0 && errors.length === 0) {
      idleRounds += 1;
      if (idleRounds >= 2) {
        return { idle: true, waitedSec: Math.round((Date.now() - started) / 1000), sessions: last };
      }
    } else {
      idleRounds = 0;
    }
    if (errors.length === last.length) {
      return {
        idle: false,
        waitedSec: Math.round((Date.now() - started) / 1000),
        errors: errors.map((x) => ({ id: x.id, error: x.error })),
        sessions: last,
      };
    }
    if ((Date.now() - started) / 1000 >= timeoutSec) {
      return {
        idle: false,
        waitedSec: timeoutSec,
        stillBusy: busy.map((x) => x.id),
        errors: errors.map((x) => ({ id: x.id, error: x.error })),
        sessions: last,
      };
    }
    await sleep(pollSec * 1000);
  }
}

function validateArgs(schema, args) {
  if (args == null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments должен быть объектом');
  const props = schema?.properties ?? {};
  const out = {};
  for (const [key, spec] of Object.entries(props)) {
    if (!(key in args)) {
      if (spec.default !== undefined) out[key] = spec.default;
      continue;
    }
    let value = args[key];
    if (spec.type === 'boolean') {
      value = value === true || value === 'true' || value === 1 || value === '1';
    } else if (spec.type === 'integer') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${key}: ожидается целое число`);
      value = Math.trunc(n);
    } else if (spec.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${key}: ожидается число`);
      value = n;
    } else if (spec.type === 'string') {
      value = String(value);
    } else if (spec.type === 'array') {
      if (!Array.isArray(value)) throw new Error(`${key}: ожидается массив`);
    } else if (spec.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${key}: ожидается объект`);
      }
    }
    if (spec.enum && !spec.enum.includes(value)) {
      throw new Error(`${key}: допустимые значения: ${spec.enum.join(', ')}`);
    }
    out[key] = value;
  }
  for (const key of schema?.required ?? []) {
    if (!(key in out)) throw new Error(`не передан обязательный аргумент: ${key}`);
  }
  for (const key of Object.keys(args)) {
    if (!(key in props)) throw new Error(`неизвестный аргумент: ${key}`);
  }
  return out;
}

const tools = {
  oc_health: {
    description: 'Состояние фонового сервера OpenCode V2 (версия, pid, url) и его доступность.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const c = connection();
      const info = await api('/api/info');
      return { ...info, healthy: info?.healthy !== false, url: c.url, servicePid: c.pid };
    },
  },

  oc_sessions: {
    description:
      'Список сессий. Аргументы: limit?(30), rootsOnly?(true — без субагентов), includeChildren?(false — добавить дочерние; только при rootsOnly:true), activeOnly?(false — только активные). Возвращает id, title, agent, model, parentID, busy, active, outcome, elapsedSec, tokens, context (limit, used, remaining, percent).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 30 },
        rootsOnly: { type: 'boolean', default: true },
        includeChildren: { type: 'boolean', default: false },
        activeOnly: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
    async run({ limit = 30, rootsOnly = true, includeChildren = false, activeOnly = false }) {
      if (includeChildren && !rootsOnly) {
        throw new Error('includeChildren доступен только при rootsOnly:true; для плоского списка используйте rootsOnly:false и parentID');
      }
      limit = Math.min(Math.max(1, limit), 1000);
      const activeIds = await getActiveSessionIds();
      let list = await allSessions();
      if (rootsOnly) list = list.filter((s) => !s.parentID);
      if (activeOnly) list = list.filter((s) => (activeIds ? activeIds.has(s.id) : isBusy(s)));
      list = list.sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0));
      const models = await getModelIndex();
      const brief = (s) => {
        const item = sessionBrief(s);
        item.active = activeIds ? activeIds.has(s.id) : item.busy;
        return item;
      };
      const picked = list.slice(0, limit).map(brief);
      await mapLimit(picked, 5, async (item) => {
        item.context = await contextFromMessages(item, models);
      });
      if (includeChildren) {
        for (const s of picked) {
          if (s.busy) {
            const kids = await childSessions(s.id);
            if (kids.length) {
              s.children = kids.map(brief);
              await mapLimit(s.children, 5, async (child) => {
                child.context = await contextFromMessages(child, models);
              });
            }
          }
        }
      }
      return picked;
    },
  },

  oc_create_session: {
    description:
      'Создать сессию. Аргументы: directory? (абсолютный путь; по умолчанию — каталог вызывающей сессии), title?, parentID? (создать субагента в каталоге родителя), agent? (id агента), model? (строка "providerID/modelID", например "opencode-go/deepseek-v4.1-flash", или {providerID, id, variant?}). Если model не указан, OpenCode берёт модель агента или модель по умолчанию.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string' },
        title: { type: 'string' },
        parentID: { type: 'string' },
        agent: { type: 'string' },
        model: { description: 'providerID/modelID или {providerID, id, variant?}' },
      },
      additionalProperties: false,
    },
    async run({ directory, title, parentID, agent, model }, ctx) {
      if (parentID && directory) throw new Error('укажите либо directory, либо parentID');
      let dir = directory ? normalizeDir(directory) : null;
      if (!dir && !parentID) {
        if (!ctx.sessionID) throw new Error('укажите directory или parentID');
        const self = await getSession(ctx.sessionID);
        dir = normalizeDir(self?.location?.directory ?? self?.directory);
        if (!dir) throw new Error('не удалось определить каталог вызывающей сессии');
      }
      const body = {};
      if (dir) body.location = { directory: dir };
      if (title !== undefined) {
        const clean = String(title).replace(/\s+/g, ' ').trim();
        if (clean) body.title = clean.slice(0, 200);
      }
      if (parentID) body.parentID = parentID;
      if (agent) body.agent = agent;
      if (model) {
        const ref = parseModelRef(model);
        const models = await getModelIndex();
        const key = `${ref.providerID}|${ref.id}`;
        if (models.size && !models.has(key)) {
          throw new Error(`модель ${key} не найдена; список доступных моделей — GET /api/model`);
        }
        body.model = ref;
      }
      const r = await api('/api/session', { method: 'POST', body: JSON.stringify(body) });
      const s = r?.data ?? r;
      return { created: true, ...sessionBrief(s) };
    },
  },

  oc_projects: {
    description:
      'Список проектов: id, canonical, name, sandboxes, число сессий и активность. Аргументы: includeArchived?(false — показать и архивные), includeCounts?(true). Устаревшее имя archived — используйте includeArchived.',
    inputSchema: {
      type: 'object',
      properties: {
        includeArchived: { type: 'boolean' },
        archived: { type: 'boolean', description: 'устаревшее имя includeArchived' },
        includeCounts: { type: 'boolean', default: true },
      },
      additionalProperties: false,
    },
    async run({ includeArchived, archived, includeCounts = true }) {
      const withArchived = includeArchived ?? archived ?? false;
      const r = await api(`/api/project?archived=${withArchived ? 'true' : 'false'}`);
      const list = Array.isArray(r) ? r : (r?.data ?? []);
      let counts = {};
      if (includeCounts) {
        const sessions = await allSessions();
        for (const x of sessions) counts[x.projectID] = (counts[x.projectID] ?? 0) + 1;
      }
      return list
        .map((p) => ({
          id: p.id,
          canonical: p.canonical ?? p.worktree ?? null,
          name: p.name ?? null,
          sandboxes: p.sandboxes ?? [],
          archived: Boolean(p.time?.archived),
          archivedAt: p.time?.archived ?? null,
          sessions: includeCounts ? counts[p.id] ?? 0 : undefined,
          activeAt: p.time?.active ?? p.time?.updated ?? null,
        }))
        .sort((a, b) => (b.sessions ?? 0) - (a.sessions ?? 0));
    },
  },

  oc_project_edit: {
    description:
      'Изменить проект: canonical (путь), name, icon, commands, archived. Аргументы: projectId + любое из полей. При смене canonical сессии проекта по умолчанию переезжают вместе с ним (moveSessions); moveAllSessions=true переносит и сессии вне старого корня (плоско, в новый canonical). Для каталога без .git/.hg id проекта пересчитывается как sha1("directory:" + путь) и ссылки в session_v2/project_directory/worktree/permission правятся — иначе OpenCode создаст дубль проекта при открытии папки. archived меняется напрямую в БД, так как API этого не умеет.',
    inputSchema: {
      type: 'object',
      required: ['projectId'],
      properties: {
        projectId: { type: 'string' },
        canonical: { type: 'string' },
        name: { type: 'string' },
        icon: { type: 'object' },
        commands: { type: 'object' },
        archived: { type: 'boolean' },
        moveSessions: { type: 'boolean', default: true },
        moveAllSessions: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
    async run({ projectId, canonical, name, icon, commands, archived, moveSessions = true, moveAllSessions = false }) {
      const all = await api('/api/project?archived=true');
      const list = Array.isArray(all) ? all : (all?.data ?? []);
      const before = list.find((p) => p.id === projectId);
      if (!before) throw new Error('проект не найден');

      const preDb = openDb();
      let pre;
      try {
        pre = preDb.prepare('select worktree, vcs from project where id = ?').get(projectId) ?? null;
      } finally {
        preDb.close();
      }

      const oldNorm = normalizeDir(pre?.worktree ?? before.canonical ?? before.worktree);
      const oldVcs = pre?.vcs ?? null;
      const body = {};
      const warnings = [];
      if (canonical !== undefined) {
        const norm = normalizeDir(canonical);
        if (!norm) throw new Error('canonical не может быть пустым');
        if (!fs.existsSync(path.normalize(norm))) warnings.push(`каталог не найден на диске: ${norm}`);
        body.canonical = norm;
      }
      if (name !== undefined) body.name = name;
      if (icon !== undefined) body.icon = icon;
      if (commands !== undefined) body.commands = commands;
      if (!Object.keys(body).length && archived === undefined) {
        throw new Error('нечего менять: укажите canonical, name, icon, commands или archived');
      }
      const canonicalChanged = canonical !== undefined && dirKey(oldNorm) !== dirKey(body.canonical);

      let patched = false;
      if (Object.keys(body).length) {
        await api(`/api/project/${encodeURIComponent(projectId)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        patched = true;
      }

      let sessionsMoved = 0;
      let sessionsSkipped = 0;
      let projectId2 = projectId;
      const d = openDb();
      try {
        d.exec('BEGIN IMMEDIATE');
        try {
          if (canonicalChanged && moveSessions) {
            const rows = d.prepare('select id, directory, path from session_v2 where project_id = ?').all(projectId);
            const skipped = [];
            for (const s of rows) {
              const dir = normalizeDir(s.directory);
              let next = mapDir(oldNorm, body.canonical, dir);
              if (!next && moveAllSessions && dirKey(dir) !== dirKey(body.canonical)) {
                next = body.canonical;
              }
              if (!next || dirKey(next) === dirKey(dir)) {
                if (
                  oldNorm &&
                  dirKey(dir) !== dirKey(body.canonical) &&
                  !dirKey(dir).startsWith(dirKey(oldNorm) + '/')
                ) {
                  skipped.push(s.id);
                }
                continue;
              }
              const nextPath = s.path == null ? null : sessionPath(next);
              d.prepare('update session_v2 set directory = ?, path = ? where id = ?')
                .run(next, nextPath, s.id);
              sessionsMoved += 1;
            }
            if (sessionsMoved) warnings.push(`каталог обновлён у сессий: ${sessionsMoved}`);
            if (skipped.length) {
              sessionsSkipped = skipped.length;
              const tail = skipped.length > 3 ? ` и ещё ${skipped.length - 3}` : '';
              warnings.push(`не тронуты сессии вне старого каталога: ${skipped.slice(0, 3).join(', ')}${tail}`);
            }
          }

          if (canonicalChanged) {
            const oldKey = dirKey(oldNorm);
            const newKey = dirKey(body.canonical);
            const dirRow = d
              .prepare('select 1 as x from project_directory where project_id = ? and lower(directory) = lower(?)')
              .get(projectId, body.canonical);
            if (dirRow) {
              d.prepare('delete from project_directory where project_id = ? and lower(directory) = lower(?)')
                .run(projectId, oldNorm);
            } else {
              const res = d
                .prepare('update project_directory set directory = ? where project_id = ? and lower(directory) = lower(?)')
                .run(body.canonical, projectId, oldNorm);
              if (res.changes) warnings.push(`project_directory обновлён: ${res.changes}`);
            }

            const sandboxRow = d.prepare('select sandboxes from project where id = ?').get(projectId);
            if (sandboxRow?.sandboxes) {
              try {
                const arr = JSON.parse(sandboxRow.sandboxes);
                if (Array.isArray(arr)) {
                  let changed = false;
                  const mapped = arr.map((x) => {
                    if (dirKey(x) === oldKey) {
                      changed = true;
                      return body.canonical;
                    }
                    return x;
                  });
                  if (changed) {
                    d.prepare('update project set sandboxes = ? where id = ?')
                      .run(JSON.stringify(mapped), projectId);
                  }
                }
              } catch {}
            }
          }

          if (canonical !== undefined) {
            const diskPath = path.normalize(body.canonical);
            const vcsRoot = detectVcsRoot(diskPath);
            if (!fs.existsSync(diskPath)) {
              warnings.push(`id не пересчитан: каталог не найден (${body.canonical})`);
            } else if (oldVcs || vcsRoot) {
              if (!oldVcs && vcsRoot) {
                warnings.push(`id не пересчитан: каталог внутри VCS (${vcsRoot}), id должен обновить сервис`);
              }
            } else {
              const want = createHash('sha1').update(`directory:${diskPath}`, 'utf8').digest('hex');
              if (want !== projectId) {
                const clash = d.prepare('select id, name from project where id = ?').get(want);
                if (clash) {
                  warnings.push(
                    `id ${want.slice(0, 8)} уже занят проектом «${clash.name ?? '(no name)'}» — id не менял`,
                  );
                } else {
                  d.exec('PRAGMA defer_foreign_keys = ON');
                  for (const t of ['permission', 'project_directory', 'session_v2', 'worktree']) {
                    d.prepare(`update ${t} set project_id = ? where project_id = ?`).run(want, projectId);
                  }
                  d.prepare('update project set id = ? where id = ?').run(want, projectId);
                  projectId2 = want;
                  warnings.push(`id проекта пересчитан под новый путь: ${projectId.slice(0, 8)} → ${want.slice(0, 8)}`);
                }
              }
            }
          }

          if (archived !== undefined) {
            const res = d
              .prepare('update project set time_archived = ? where id = ?')
              .run(archived ? Date.now() : null, projectId2);
            if (!res.changes) throw new Error('проект не найден');
            warnings.push('archived изменён напрямую в БД: API не поддерживает архивацию проектов');
          }

          d.exec('COMMIT');
        } catch (e) {
          d.exec('ROLLBACK');
          throw e;
        }
      } catch (e) {
        if (patched && canonicalChanged) {
          try {
            await api(`/api/project/${encodeURIComponent(projectId)}`, {
              method: 'PATCH',
              body: JSON.stringify({ canonical: oldNorm }),
            });
          } catch (e2) {
            e.message += `; не удалось вернуть canonical: ${e2.message}`;
          }
        }
        throw e;
      } finally {
        d.close();
      }

      let freshList = [];
      try {
        const freshAll = await api('/api/project?archived=true');
        freshList = Array.isArray(freshAll) ? freshAll : (freshAll?.data ?? []);
      } catch (e) {
        warnings.push(`не удалось перечитать проект: ${e.message}`);
      }
      const after =
        freshList.find((p) => p.id === projectId2) ??
        (canonical !== undefined
          ? freshList.find((p) => dirKey(p.canonical ?? p.worktree) === dirKey(body.canonical))
          : null);
      if (freshList.length && !after) warnings.push('сервис пока не показывает проект после изменения');

      return {
        ok: true,
        id: projectId2,
        before: {
          canonical: before.canonical ?? before.worktree ?? null,
          name: before.name ?? null,
          archived: Boolean(before.time?.archived),
        },
        after: after
          ? { canonical: after.canonical ?? after.worktree ?? null, name: after.name ?? null, archived: Boolean(after.time?.archived) }
          : null,
        via: archived !== undefined ? 'sqlite+api' : canonical !== undefined ? 'api+sqlite' : 'api',
        sessionsMoved,
        sessionsSkipped,
        warnings,
      };
    },
  },

  oc_project_delete: {
    description:
      'Удалить проект и все его сессии (каскад). Аргументы: projectId, force?(false — обязателен, если в проекте есть сессии), dryRun?(false — только посчитать). Пишет напрямую в БД: API удаления проектов не имеет.',
    inputSchema: {
      type: 'object',
      required: ['projectId'],
      properties: {
        projectId: { type: 'string' },
        force: { type: 'boolean', default: false },
        dryRun: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
    async run({ projectId, force = false, dryRun = false }, ctx) {
      if (projectId === 'global') throw new Error('проект global удалять нельзя');
      const d = openDb();
      try {
        const proj = d.prepare('select id, worktree, name from project where id = ?').get(projectId);
        if (!proj) throw new Error('проект не найден');
        if (ctx?.sessionID) {
          const own = d.prepare('select project_id from session_v2 where id = ?').get(ctx.sessionID);
          if (own?.project_id === projectId) {
            throw new Error('нельзя удалять проект вызывающей сессии');
          }
        }
        const sessions = d.prepare('select id from session_v2 where project_id = ?').all(projectId);
        const ids = sessions.map((s) => s.id);
        let messages = 0;
        if (ids.length) {
          const marks = ids.map(() => '?').join(',');
          messages = d.prepare(`select count(*) as c from session_message where session_id in (${marks})`).get(...ids).c;
        }
        const sandboxes = d.prepare('select count(*) as c from project_directory where project_id = ?').get(projectId).c;
        const worktrees = d.prepare('select count(*) as c from worktree where project_id = ?').get(projectId).c;
        const busySessions = d.prepare(
          'select count(*) as c from session_v2 where project_id = ? and coalesce(time_busy, 0) > coalesce(time_idle, 0)',
        ).get(projectId).c;
        const summary = {
          projectId,
          canonical: proj.worktree,
          name: proj.name,
          sessions: ids.length,
          messages,
          sandboxes,
          worktrees,
          busySessions,
        };
        if (dryRun) return { ...summary, dryRun: true, wouldDelete: true };
        if (ids.length && !force) {
          throw new Error(
            `в проекте ${ids.length} сессий (${messages} сообщений, занятых: ${busySessions}). Удаление каскадное и необратимое — повторите с force:true`,
          );
        }
        const cleanupErrors = [];
        d.exec('BEGIN IMMEDIATE');
        try {
          for (const id of ids) {
            for (const [sql, params] of [
              ['delete from session_inbox where session_id = ?', [id]],
              ['delete from job where session_id = ? or child_session_id = ?', [id, id]],
              ['delete from event where aggregate_id = ?', [id]],
              ['delete from event_sequence where aggregate_id = ?', [id]],
            ]) {
              try {
                d.prepare(sql).run(...params);
              } catch {}
            }
          }
          if (ids.length) {
            const marks = ids.map(() => '?').join(',');
            d.prepare(`update session_v2 set fork_session_id = null where fork_session_id in (${marks})`).run(...ids);
          }
          try {
            d.prepare('delete from event where aggregate_id = ?').run(projectId);
            d.prepare('delete from event_sequence where aggregate_id = ?').run(projectId);
          } catch {}
          d.prepare('delete from worktree where project_id = ?').run(projectId);
          d.prepare('delete from project_directory where project_id = ?').run(projectId);
          d.prepare('delete from session_v2 where project_id = ?').run(projectId);
          d.prepare('delete from project where id = ?').run(projectId);
          d.exec('COMMIT');
        } catch (e) {
          d.exec('ROLLBACK');
          throw e;
        }
        deleteTodos(ids, cleanupErrors);
        return {
          ...summary,
          deleted: true,
          forced: Boolean(ids.length && force),
          cleanupErrors: cleanupErrors.length ? cleanupErrors : undefined,
        };
      } finally {
        d.close();
      }
    },
  },

  oc_session_delete: {
    description:
      'Удалить сессию и все её дочерние сессии (API делает это каскадно) и почистить todo/job/event в БД. Аргументы: sessionId, dryRun?(false — только посчитать). Необратимо.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string' },
        dryRun: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
    async run({ sessionId, dryRun = false }) {
      const target = await getSession(sessionId);
      if (!target) throw new Error('сессия не найдена');
      const list = await allSessions();
      const children = [];
      const queue = [sessionId];
      while (queue.length) {
        const cur = queue.shift();
        for (const s of list) {
          if (s.parentID === cur) {
            children.push(s.id);
            queue.push(s.id);
          }
        }
      }
      const ids = [sessionId, ...children];
      const cleanupErrors = [];
      let messages = 0;
      try {
        const d = openDb({ readOnly: true });
        try {
          const marks = ids.map(() => '?').join(',');
          messages = d.prepare(`select count(*) as c from session_message where session_id in (${marks})`).get(...ids).c;
        } finally {
          d.close();
        }
      } catch (e) {
        cleanupErrors.push(`count: ${e.message}`);
      }
      const summary = { sessionId, title: target.title, sessions: ids.length, children: children.length, messages };
      if (dryRun) return { ...summary, dryRun: true };
      await api(`/api/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });

      try {
        const d = openDb();
        try {
          d.exec('BEGIN IMMEDIATE');
          try {
            for (const id of ids) {
              for (const [sql, params] of [
                ['delete from job where session_id = ? or child_session_id = ?', [id, id]],
                ['delete from event where aggregate_id = ?', [id]],
                ['delete from event_sequence where aggregate_id = ?', [id]],
              ]) {
                try {
                  d.prepare(sql).run(...params);
                } catch (e) {
                  cleanupErrors.push(`${id}: ${e.message}`);
                }
              }
            }
            const marks = ids.map(() => '?').join(',');
            d.prepare(`update session_v2 set fork_session_id = null where fork_session_id in (${marks})`).run(...ids);
            d.exec('COMMIT');
          } catch (e) {
            d.exec('ROLLBACK');
            cleanupErrors.push(e.message);
          }
        } finally {
          d.close();
        }
      } catch (e) {
        cleanupErrors.push(e.message);
      }

      deleteTodos(ids, cleanupErrors);
      return { ...summary, deleted: true, cleanupErrors: cleanupErrors.length ? cleanupErrors : undefined };
    },
  },

  oc_children: {
    description:
      'Дочерние сессии (субагенты): список со статусом, временем, последними сообщениями и заполнением контекста. Аргументы: sessionId? (по умолчанию — вызывающая сессия), limit?(30, max 1000), includeMessages?(3), activeOnly?(false). total — после activeOnly, count — после limit, truncated — лимит отрезал часть.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        limit: { type: 'integer', default: 30 },
        includeMessages: { type: 'integer', default: 3 },
        activeOnly: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
    async run({ sessionId, limit = 30, includeMessages = 3, activeOnly = false }, ctx) {
      limit = Math.min(Math.max(1, limit), 1000);
      includeMessages = Math.min(Math.max(0, includeMessages), 50);
      const parentId = sessionId ?? ctx.sessionID;
      if (!parentId) throw new Error('не удалось определить сессию: передайте sessionId');
      const kids = await childSessions(parentId);
      const activeIds = activeOnly ? await getActiveSessionIds() : null;
      const filtered = activeOnly ? kids.filter((s) => (activeIds ? activeIds.has(s.id) : isBusy(s))) : kids;
      const sorted = filtered.sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
      const total = sorted.length;
      const picked = sorted.slice(0, limit);
      return {
        parentID: parentId,
        count: picked.length,
        total,
        limit,
        truncated: total > picked.length,
        sessions: await snapshot(picked.map((s) => s.id), includeMessages),
      };
    },
  },

  oc_watch: {
    description:
      'Наблюдение за субагентом: снимок или ожидание завершения. Аргументы: sessionId? (по умолчанию — все дети вызывающей сессии), waitSec?(0 — только снимок), pollSec?(5), includeMessages?(3), full?(false — больше полей). В сессиях возвращает context: model, limit, used, remaining, percent (used — оценка по последнему assistant-сообщению).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        waitSec: { type: 'integer', default: 0 },
        pollSec: { type: 'integer', default: 5 },
        includeMessages: { type: 'integer', default: 3 },
        full: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
    async run({ sessionId, waitSec = 0, pollSec = 5, includeMessages = 3, full = false }, ctx) {
      waitSec = Math.min(Math.max(0, waitSec), 3600);
      pollSec = Math.min(Math.max(1, pollSec), 60);
      includeMessages = Math.min(Math.max(0, includeMessages), 50);
      let ids;
      let parentId = null;
      if (sessionId) {
        ids = [sessionId];
      } else {
        parentId = ctx.sessionID;
        if (!parentId) throw new Error('не удалось определить сессию: передайте sessionId');
        const kids = await childSessions(parentId);
        ids = kids.map((s) => s.id);
      }
      if (ids.length === 0) return { parentID: parentId, count: 0, sessions: [] };
      if (waitSec > 0) {
        const res = await waitIdle(ids, waitSec, pollSec, includeMessages);
        return { parentID: parentId, ...res };
      }
      return { parentID: parentId, count: ids.length, sessions: await snapshot(ids, includeMessages, full) };
    },
  },

  oc_messages: {
    description:
      'Сообщения сессии. Аргументы: sessionId, limit?(5, максимум 50), order?("desc"|"asc"). Возвращает [{type, at, text}] — текст склеен, tool-вызовы помечены.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string' },
        limit: { type: 'integer', default: 5 },
        order: { type: 'string', enum: ['desc', 'asc'], default: 'desc' },
      },
      additionalProperties: false,
    },
    async run({ sessionId, limit = 5, order = 'desc' }) {
      limit = Math.max(1, Math.min(limit, 50));
      return lastMessages(sessionId, limit, order);
    },
  },

  oc_prompt: {
    description:
      'Отправить сообщение в сессию. Аргументы: sessionId, text, from? (метка отправителя, подставляется первой строкой), delivery?("steer"|"queue"), resume?(true — по умолчанию будит получателя).',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'text'],
      properties: {
        sessionId: { type: 'string' },
        text: { type: 'string' },
        from: { type: 'string' },
        delivery: { type: 'string', enum: ['steer', 'queue'] },
        resume: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    async run({ sessionId, text, from, delivery, resume }) {
      if (from) text = `[from: ${from}]\n${text}`;
      const body = { text, resume: resume ?? true };
      if (delivery) body.delivery = delivery;
      const r = await api(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return { sent: true, message: r?.data ?? r };
    },
  },

  oc_report: {
    description:
      'Отчёт о ходе работы наверх: отправляет synthetic-сообщение родительской сессии. Аргументы: text, kind?("progress"|"result"|"blocked"), resume? (по умолчанию true для result/blocked и false для progress), to? (явный sessionId получателя). Вызывающая сессия определяется автоматически. При resume=false сообщение остаётся во входящих родителя до его следующего хода; при resume=true будит родителя.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string' },
        kind: { type: 'string', enum: ['progress', 'result', 'blocked'], default: 'progress' },
        resume: { type: 'boolean' },
        to: { type: 'string' },
      },
      additionalProperties: false,
    },
    async run({ text, kind = 'progress', resume, to }, ctx) {
      const selfId = ctx.sessionID;
      let target = to;
      if (!target) {
        if (!selfId) throw new Error('не удалось определить вызывающую сессию: передайте to');
        const self = await getSession(selfId);
        target = self?.parentID;
        if (!target) throw new Error('вызывающая сессия не является субагентом: передайте to');
      }
      const label = kind === 'result' ? 'ИТОГ' : kind === 'blocked' ? 'БЛОКЕР' : 'ПРОГРЕСС';
      const wake = resume ?? kind !== 'progress';
      const body = {
        text: `[${label}] ${text}`,
        resume: wake,
        metadata: { source: 'oc-control', childID: selfId ?? null, kind },
      };
      const r = await api(`/api/session/${encodeURIComponent(target)}/synthetic`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const msg = r?.data ?? r;
      return { reported: true, to: target, from: selfId ?? null, kind, resume: wake, messageID: msg?.id ?? null };
    },
  },

  oc_session_edit: {
    description:
      'Изменить сессию: title, directory (перенос в другой каталог — сам пересчитает проект), archived, permissions, metadata. Аргументы: sessionId + любое из полей. Перенос добавляет служебные сообщения location-switched/idle.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string' },
        title: { type: 'string' },
        directory: { type: 'string' },
        archived: { type: 'boolean' },
        permissions: { type: 'array' },
        metadata: { type: 'object' },
      },
      additionalProperties: false,
    },
    async run({ sessionId, title, directory, archived, permissions, metadata }) {
      const before = await getSession(sessionId);
      const notes = [];
      const patch = {};
      if (title !== undefined) {
        const clean = String(title).replace(/\s+/g, ' ').trim();
        if (!clean) throw new Error('title не может быть пустым');
        patch.title = clean.slice(0, 200);
      }
      if (archived !== undefined) patch.archived = archived;
      if (permissions !== undefined) patch.permissions = permissions;
      if (metadata !== undefined) patch.metadata = metadata;

      let after = before;
      if (Object.keys(patch).length) {
        const r = await api(`/api/session/${encodeURIComponent(sessionId)}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
        after = r?.data ?? r ?? after;
      }
      if (directory !== undefined) {
        const norm = String(directory).replace(/\\/g, '/').replace(/\/+$/, '');
        const oldDir = before?.location?.directory ?? before?.directory ?? null;
        if (oldDir !== norm) {
          if (!fs.existsSync(norm)) notes.push(`каталог не найден на диске: ${norm}`);
          await api(`/api/session/${encodeURIComponent(sessionId)}/move`, {
            method: 'POST',
            body: JSON.stringify({ directory: norm }),
          });
          let applied = false;
          for (let i = 0; i < 20; i++) {
            await sleep(300);
            after = await getSession(sessionId);
            const now = after?.location?.directory ?? after?.directory ?? null;
            if (String(now).replace(/\\/g, '/').replace(/\/+$/, '') === norm) {
              applied = true;
              break;
            }
          }
          notes.push(
            applied
              ? 'сессия перемещена; в истории появились служебные сообщения location-switched/idle'
              : 'перемещение отправлено, но ещё не применилось (сессия занята?) — проверьте позже',
          );
        }
      }
      const brief = (s) => ({
        title: s?.title ?? null,
        directory: String(s?.location?.directory ?? s?.directory ?? '').replace(/\\/g, '/') || null,
        projectID: s?.projectID ?? null,
        archived: Boolean(s?.time?.archived),
      });
      return { ok: true, id: sessionId, before: brief(before), after: brief(after), notes };
    },
  },

  oc_inbox: {
    description:
      'Входящие сессии: доставленные в очередь, но ещё не обработанные сообщения (в том числе отчёты субагентов). Аргументы: sessionId? (по умолчанию — вызывающая сессия), limit?(20).',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, limit: { type: 'integer', default: 20 } },
      additionalProperties: false,
    },
    async run({ sessionId, limit = 20 }, ctx) {
      limit = Math.min(Math.max(1, limit), 200);
      const id = sessionId ?? ctx.sessionID;
      if (!id) throw new Error('не удалось определить сессию: передайте sessionId');
      const r = await api(`/api/session/${encodeURIComponent(id)}/inbox`);
      const list = Array.isArray(r?.data) ? r.data : [];
      return {
        sessionID: id,
        count: list.length,
        items: list.slice(0, limit).map((m) => ({
          id: m.id,
          type: m.type,
          delivery: m.delivery ?? null,
          at: m.time?.created ? new Date(m.time.created).toISOString() : null,
          text: (m.payload?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
          metadata: m.payload?.metadata ?? null,
        })),
      };
    },
  },
};

const toolDefs = Object.entries(tools).map(([name, t]) => ({
  name,
  description: t.description,
  inputSchema: t.inputSchema,
}));

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'oc-control', version: VERSION },
        },
      });
      return;
    }
    if (method === 'ping') {
      send({ id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      send({ id, result: { tools: toolDefs } });
      return;
    }
    if (method === 'tools/call') {
      const tool = tools[params?.name];
      if (!tool) throw new Error(`unknown tool: ${params?.name}`);
      const ctx = { sessionID: params?._meta?.[META_KEY] ?? null };
      const args = validateArgs(tool.inputSchema, params?.arguments);
      const result = await tool.run(args, ctx);
      send({
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      });
      return;
    }
    if (id !== undefined) {
      send({ id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    if (id !== undefined) {
      send({
        id,
        result: { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true },
      });
    }
  }
}

const DEBUG_LOG = process.env.OC_CONTROL_DEBUG;
function dbg(s) {
  if (DEBUG_LOG) {
    try {
      fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${s}\n`);
    } catch {}
  }
}

dbg(`ready pid=${process.pid} version=${VERSION}`);
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const s = line.trim();
  dbg(`recv: ${s.slice(0, 200)}`);
  if (!s) return;
  try {
    handle(JSON.parse(s));
  } catch {
    process.stderr.write('oc-control: bad json line\n');
  }
});
process.stderr.write(`oc-control ${VERSION} ready\n`);
