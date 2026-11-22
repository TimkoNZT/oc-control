#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'oc-control.mjs');

const results = [];
let skipped = 0;

function check(name, ok, details) {
  results.push({ name, ok, details });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${details ? '  — ' + details : ''}`);
}

function skip(name, reason) {
  skipped += 1;
  console.log(`SKIP  ${name} — ${reason}`);
}

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
const sameDir = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

function rpc(method, params, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    pending.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function call(name, args, sessionID, timeoutMs = 120000) {
  const params = { name, arguments: args ?? {} };
  if (sessionID) params._meta = { 'ai.opencode/sessionID': sessionID };
  const m = await rpc('tools/call', params, timeoutMs);
  const text = m.result?.content?.[0]?.text ?? '';
  if (m.result?.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function childrenOf(sessionId) {
  const r = await call('oc_children', { sessionId, includeMessages: 0 });
  return r.sessions ?? [];
}

async function pickFixtures(roots) {
  let parent = process.env.TEST_PARENT || null;
  let childId = process.env.TEST_CHILD || null;

  if (!parent || !childId) {
    for (const root of roots) {
      const kids = await childrenOf(root.id);
      if (!kids.length) continue;
      parent ||= root.id;
      if (!childId) childId = (kids.find((s) => !s.busy) ?? kids[0]).id;
      break;
    }
  }

  if (!parent || !childId) {
    throw new Error(
      'нужен хотя бы один субагент: запустите subagent или задайте TEST_PARENT/TEST_CHILD',
    );
  }

  return { parent, childId, target: process.env.TEST_CHILD_TARGET || null };
}

async function pickMoveDir(current) {
  if (process.env.TEST_MOVE_DIR) {
    const dir = norm(process.env.TEST_MOVE_DIR);
    return fs.existsSync(dir) ? dir : null;
  }
  const projects = await call('oc_projects', { includeCounts: true });
  for (const project of projects) {
    const dir = norm(project.canonical);
    if (!dir || project.id === 'global' || sameDir(dir, current)) continue;
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  check('initialize', init.result?.serverInfo?.name === 'oc-control', init.result?.serverInfo?.version);

  const list = await rpc('tools/list', {});
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  const expected = ['oc_children', 'oc_create_session', 'oc_health', 'oc_inbox', 'oc_messages',
    'oc_project_delete', 'oc_project_edit', 'oc_projects', 'oc_prompt', 'oc_report',
    'oc_session_delete', 'oc_session_edit', 'oc_sessions', 'oc_watch'];
  check('tools/list', JSON.stringify(names) === JSON.stringify(expected), `${names.length} tools`);
  check('no v1 instance tools', !names.some((n) => /spawn_worker|attach|tui_prompt|close_all|serve|windows|toast/.test(n)));
  check('no useless tools', !names.some((n) => /wait_idle|stop|oc_rename/.test(n)));

  const health = await call('oc_health', {});
  check('oc_health', health.healthy === true && Boolean(health.version), `${health.url} v${health.version}`);

  const roots = await call('oc_sessions', { limit: 100 });
  check('oc_sessions roots only', Array.isArray(roots) && roots.length > 0 && roots.every((s) => !s.parentID),
    `${roots.length} sessions`);
  check('oc_sessions context', roots.some((s) => s.context?.limit > 0 && s.context?.used != null),
    roots.map((s) => s.context?.percent).filter((x) => x != null).slice(0, 3).join(', '));

  const { parent, childId, target } = await pickFixtures(roots);

  const childInfo = (await call('oc_watch', { sessionId: childId, includeMessages: 0, full: true }))
    .sessions?.[0] ?? {};
  const originalDir = norm(childInfo.directory);
  const modelRef = childInfo.model ? `${childInfo.model.providerID}/${childInfo.model.id}` : null;
  const originalTitle = childInfo.title ?? null;
  const childBrief = await call('oc_session_edit', { sessionId: childId });
  const childProjectID = childBrief.before?.projectID ?? null;

  const msgs = await call('oc_messages', { sessionId: childId, limit: 3 });
  check('oc_messages', Array.isArray(msgs) && msgs.length > 0 && typeof msgs[0].text === 'string',
    msgs.map((m) => m.text.slice(0, 24)).join(' | ').slice(0, 110));

  const children = await call('oc_children', { includeMessages: 1 }, parent);
  check('oc_children by caller session', children.parentID === parent && children.count >= 1,
    `${children.count} children`);

  const watch = await call('oc_watch', { includeMessages: 1 }, parent);
  check('oc_watch children snapshot', Array.isArray(watch.sessions) && watch.sessions.length === children.count,
    `${watch.sessions.length} watched`);

  const single = await call('oc_watch', { sessionId: childId, includeMessages: 2 });
  check('oc_watch single session', single.sessions?.[0]?.id === childId,
    `outcome=${single.sessions?.[0]?.outcome} busy=${single.sessions?.[0]?.busy}`);
  check('oc_watch context', single.sessions?.[0]?.context?.limit > 0 && single.sessions?.[0]?.context?.used != null,
    `limit=${single.sessions?.[0]?.context?.limit} percent=${single.sessions?.[0]?.context?.percent}`);

  if (target) {
    const progress = await call('oc_report', { text: 'e2e progress', kind: 'progress', to: target }, childId);
    check('oc_report progress accepted', progress.reported === true && progress.resume === false,
      `${progress.from} -> ${progress.to}`);

    const inbox = await call('oc_inbox', { sessionId: target });
    check('oc_report progress в inbox', inbox.items.some((i) => i.text.includes('e2e progress')),
      `${inbox.count} items, last=${inbox.items[0]?.text?.slice(0, 40) ?? '—'}`);

    const result = await call('oc_report', { text: 'e2e result', kind: 'result', to: target }, childId);
    check('oc_report result accepted', result.reported === true && result.resume === true,
      `messageID=${result.messageID}`);

    const after = await call('oc_messages', { sessionId: target, limit: 6 });
    check('oc_report result в истории', after.some((m) => m.text.includes('e2e result')),
      after.slice(0, 2).map((m) => m.type).join(','));

    const prompted = await call('oc_prompt', { sessionId: target, text: 'e2e prompt', resume: false });
    check('oc_prompt accepted', prompted.sent === true, prompted.message?.id ?? '');
    const inbox2 = await call('oc_inbox', { sessionId: target });
    check('oc_prompt в inbox', inbox2.items.some((i) => i.text.includes('e2e prompt')), `${inbox2.count} items`);
  } else {
    for (const name of ['oc_report progress accepted', 'oc_report progress в inbox', 'oc_report result accepted',
      'oc_report result в истории', 'oc_prompt accepted', 'oc_prompt в inbox']) {
      skip(name, 'нет второй сессии для получателя (задайте TEST_CHILD_TARGET)');
    }
  }

  let rootError = null;
  try {
    await call('oc_report', { text: 'root' }, parent);
  } catch (e) {
    rootError = e.message;
  }
  check('oc_report из корня -> ошибка', /не является субагентом/.test(rootError ?? ''), rootError ?? 'нет ошибки');

  const projects = await call('oc_projects', { includeCounts: true });
  check('oc_projects', Array.isArray(projects) && projects.length > 0 && projects.some((p) => p.canonical),
    `${projects.length} projects`);

  let project =
    projects.find((p) => p.id === process.env.TEST_PROJECT) ??
    projects.find((p) => p.id === childProjectID) ??
    projects.find((p) => p.id !== 'global' && p.sessions > 0 && p.canonical) ??
    null;
  if (project?.id === 'global') project = null;

  if (project) {
    let archiveOk = false;
    let archiveVia = null;
    let archiveError = null;
    try {
      const arch = await call('oc_project_edit', { projectId: project.id, archived: true });
      archiveVia = arch.via;
      const listArch = await call('oc_projects', { includeArchived: true });
      const listNo = await call('oc_projects', { includeArchived: false });
      archiveOk =
        arch.after?.archived === true &&
        Boolean(listArch.find((p) => p.id === project.id)?.archived) &&
        !listNo.find((p) => p.id === project.id);
    } catch (e) {
      archiveError = e.message;
    } finally {
      try {
        await call('oc_project_edit', { projectId: project.id, archived: false });
      } catch {}
    }
    check('oc_project_edit archive', archiveOk, archiveError ?? `via=${archiveVia}`);

    const listBack = await call('oc_projects', { includeArchived: false });
    check('oc_project_edit unarchive', Boolean(listBack.find((p) => p.id === project.id)),
      `project=${project.id.slice(0, 10)}`);

    const delDry = await call('oc_project_delete', { projectId: project.id, dryRun: true });
    check('oc_project_delete dryRun', delDry.dryRun === true && delDry.sessions > 0,
      `${delDry.sessions} sessions, ${delDry.messages} msg`);
    if (delDry.sessions > 0) {
      let delErr = null;
      try {
        await call('oc_project_delete', { projectId: project.id });
      } catch (e) {
        delErr = e.message;
      }
      check('oc_project_delete guard', /force:true/.test(delErr ?? ''), (delErr ?? 'нет ошибки').slice(0, 80));
    } else {
      skip('oc_project_delete guard', 'проект пуст — вызов без force реально удалил бы его');
    }

    if (project.name) {
      const pe = await call('oc_project_edit', { projectId: project.id, name: project.name });
      check('oc_project_edit no-op', pe.ok === true && pe.after?.name === project.name &&
        pe.sessionsMoved === 0 && pe.sessionsSkipped === 0,
        `${pe.before?.name} -> ${pe.after?.name}, moved=${pe.sessionsMoved}`);
    } else {
      skip('oc_project_edit no-op', 'у проекта нет имени');
    }
  } else {
    for (const name of ['oc_project_edit archive', 'oc_project_edit unarchive',
      'oc_project_delete dryRun', 'oc_project_delete guard', 'oc_project_edit no-op']) {
      skip(name, 'нет проекта с сессиями (задайте TEST_PROJECT)');
    }
  }

  const sd = await call('oc_session_delete', { sessionId: childId, dryRun: true });
  check('oc_session_delete dryRun', sd.dryRun === true && sd.sessions >= 1,
    `${sd.sessions} sessions, ${sd.messages} msg`);

  let createdSession = null;
  if (originalDir) {
    try {
      createdSession = await call('oc_create_session', {
        directory: originalDir,
        title: `E2E create ${new Date().toISOString().slice(11, 19)}`,
        ...(modelRef ? { model: modelRef } : {}),
      });
      const modelOk =
        !modelRef ||
        (createdSession.model?.providerID === childInfo.model.providerID && createdSession.model?.id === childInfo.model.id);
      check(
        'oc_create_session',
        Boolean(createdSession.id) && sameDir(createdSession.directory, originalDir) && modelOk,
        `${createdSession.id?.slice(0, 12)} ${modelRef ?? 'default model'}`,
      );
    } catch (e) {
      check('oc_create_session', false, e.message);
    } finally {
      if (createdSession?.id) {
        try {
          await call('oc_session_delete', { sessionId: createdSession.id });
        } catch {}
      }
    }
  } else {
    skip('oc_create_session', 'не удалось определить каталог');
  }

  const newTitle = `E2E edit ${new Date().toISOString().slice(11, 19)}`;
  try {
    const edited = await call('oc_session_edit', { sessionId: childId, title: newTitle });
    const editedCheck = await call('oc_watch', { sessionId: childId, includeMessages: 0 });
    check('oc_session_edit title', edited.ok === true && editedCheck.sessions?.[0]?.title === newTitle,
      editedCheck.sessions?.[0]?.title);

    let emptyError = null;
    try {
      await call('oc_session_edit', { sessionId: childId, title: '   ' });
    } catch (e) {
      emptyError = e.message;
    }
    check('oc_session_edit пустой title -> ошибка', /не может быть пустым/.test(emptyError ?? ''), emptyError ?? 'нет ошибки');
  } finally {
    if (originalTitle) {
      try {
        await call('oc_session_edit', { sessionId: childId, title: originalTitle });
      } catch {}
    }
  }

  const moveDir = originalDir ? await pickMoveDir(originalDir) : null;
  if (!moveDir) {
    skip('oc_session_edit directory', 'нет второго существующего проекта (задайте TEST_MOVE_DIR)');
    skip('oc_session_edit directory back', 'нет второго существующего проекта (задайте TEST_MOVE_DIR)');
  } else {
    let moved = null;
    let moveError = null;
    try {
      try {
        moved = await call('oc_session_edit', { sessionId: childId, directory: moveDir }, null, 60000);
      } catch (e) {
        moveError = e.message;
      }
      check('oc_session_edit directory', !moveError && moved?.ok === true && sameDir(moved?.after?.directory, moveDir),
        moveError ?? `${norm(moved?.before?.directory)} -> ${norm(moved?.after?.directory)}`);
    } finally {
      let back = null;
      let backError = null;
      try {
        back = await call('oc_session_edit', { sessionId: childId, directory: originalDir }, null, 60000);
      } catch (e) {
        backError = e.message;
      }
      check('oc_session_edit directory back', !backError && sameDir(back?.after?.directory, originalDir),
        backError ?? `project=${back?.after?.projectID?.slice(0, 8)} notes=${(back?.notes ?? []).length}`);
    }
  }

  if (process.env.TEST_DELETE_SESSION) {
    const victim = process.env.TEST_DELETE_SESSION;
    if (victim === parent || victim === childId) {
      skip('oc_session_delete', 'нельзя удалять сессии-фикстуры');
    } else {
      const delOne = await call('oc_session_delete', { sessionId: victim });
      let gone = false;
      try {
        await call('oc_watch', { sessionId: victim, includeMessages: 0 });
      } catch {
        gone = true;
      }
      check('oc_session_delete', delOne.deleted === true && gone, victim.slice(0, 12));
    }
  } else {
    skip('oc_session_delete', 'задайте TEST_DELETE_SESSION=<ses_...>');
  }

  if (process.env.TEST_DELETE_PROJECT) {
    const pid = process.env.TEST_DELETE_PROJECT;
    const dry = await call('oc_project_delete', { projectId: pid, dryRun: true });
    const del = await call('oc_project_delete', { projectId: pid, force: true });
    const afterAll = await call('oc_projects', { includeArchived: true });
    check('oc_project_delete', dry.dryRun === true && del.deleted === true && !afterAll.find((p) => p.id === pid),
      `${dry.sessions} sessions, ${dry.messages} msg`);
  } else {
    skip('oc_project_delete', 'задайте TEST_DELETE_PROJECT=<id>');
  }
} catch (e) {
  check('unexpected error', false, e.message);
} finally {
  child.stdin.end();
  child.kill();
}

const failed = results.filter((r) => !r.ok);
const tail = skipped ? `, ${skipped} skipped` : '';
console.log(`\n${results.length - failed.length}/${results.length} passed${tail}`);
process.exitCode = failed.length ? 1 : 0;
