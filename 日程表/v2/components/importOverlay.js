// §5.7 一键导入浮层：输入（文字/图片）→ 预览确认（可编辑清单）→ 写库。
// 图片模式由调用方注入 parseImage(dataUrl, hooks) → Promise<与 parseImportText 同构的结果>；
// 未注入时图片分段不渲染（P3 文字线可独立上线，P6 接线后自动出现）。
import { h, clear } from '../lib/dom.js';
import { openOverlay, closeOverlay, toast } from '../lib/feedback.js';
import { parseImportText } from '../lib/import/parseText.js';
import {
  loadCourses, upsertCourse, removeImportedCourses, hasImportedCourses,
  newCourseId, validateCourse, COURSE_COLORS, StoreError,
} from '../lib/courseStore.js';
import { weeksOverlap } from '../lib/weeks.js';
import { PERIODS, WEEK_LABELS } from '../data/semester.js';

const COLOR_LABELS = { blue: '蓝', purple: '紫', green: '绿', orange: '橙', cyan: '青', pink: '粉' };

export function openImportOverlay({ onDone, parseImage = null } = {}) {
  const state = {
    mode: 'text', step: 'input',
    rows: [], unparsed: [], candidates: [],
    image: null, parseBtn: null, textArea: null,
  };

  const stepHost = h('div', { class: 'imp-step' });
  const panel = openOverlay({ title: '一键导入课表', body: h('div', { class: 'imp' }, stepHost) });

  document.addEventListener('paste', onGlobalPaste);

  function go(step) { state.step = step; render(); }

  function render() {
    clear(stepHost);
    if (state.step === 'input') stepHost.appendChild(renderInput());
    else if (state.step === 'loss') stepHost.appendChild(renderLoss());
    else if (state.step === 'semi') stepHost.appendChild(renderSemi());
    else if (state.step === 'preview') stepHost.appendChild(renderPreview());
  }

  // ---------- 步骤 1：输入 ----------

  function renderInput() {
    const wrap = h('div', { class: 'imp-input' });
    const segBtns = [h('button', {
      class: `seg-btn${state.mode === 'text' ? ' active' : ''}`, type: 'button',
      onclick: () => { state.mode = 'text'; render(); },
    }, '文字')];
    if (parseImage) {
      segBtns.push(h('button', {
        class: `seg-btn${state.mode === 'image' ? ' active' : ''}`, type: 'button',
        onclick: () => { state.mode = 'image'; render(); },
      }, '图片'));
    }
    wrap.appendChild(h('div', { class: 'seg imp-seg' }, ...segBtns));

    if (state.mode === 'text') {
      wrap.appendChild(h('div', { class: 'imp-hint' }, '请复制您的课表并粘贴'));
      state.textArea = h('textarea', {
        class: 'imp-area', rows: '8',
        placeholder: '每行一条安排，例如：高等数学 周一 第1-2节 教学一号楼101',
        oninput: () => syncParseBtn(),
      });
      wrap.appendChild(state.textArea);
      wrap.appendChild(h('div', { class: 'imp-note' }, '支持从教务系统/课程表 App/Excel 复制后直接粘贴，每行一条安排；内容仅在本机解析，不会上传'));
    } else {
      wrap.appendChild(h('div', { class: 'imp-hint' }, '上传或粘贴课表截图'));
      const fileInput = h('input', {
        class: 'imp-file', type: 'file', accept: 'image/*',
        onchange: (e) => readFile(e.target?.files?.[0]),
      });
      wrap.appendChild(h('div', {
        class: 'imp-drop', type: 'button', tabindex: '0', role: 'button',
        onclick: () => fileInput.click(),
        ondragover: (e) => e.preventDefault?.(),
        ondrop: (e) => { e.preventDefault?.(); readFile(e.dataTransfer?.files?.[0]); },
      }, '点击选择课表截图，或按 Ctrl+V 粘贴'));
      wrap.appendChild(fileInput);
      if (state.image) {
        wrap.appendChild(h('img', { class: 'imp-thumb', src: state.image, alt: '课表截图预览' }));
        wrap.appendChild(h('button', {
          class: 'btn imp-remove', type: 'button',
          onclick: () => { state.image = null; render(); },
        }, '移除图片'));
      }
      wrap.appendChild(h('div', { class: 'imp-note' }, '截图在本机识别，不会上传；教务系统网页版或课程表 App 的课表页截图识别效果最好'));
    }

    if (hasImportedCourses()) {
      wrap.appendChild(h('button', { class: 'btn danger imp-clear', type: 'button', onclick: clearImported }, '清除全部导入课'));
    }
    state.parseBtn = h('button', { class: 'btn primary imp-parse', type: 'button', disabled: true, onclick: onParse }, '解析');
    wrap.appendChild(state.parseBtn);
    syncParseBtn(); // 整段 render 都会重建按钮：文字/图片两态的可用性都要在这里对账
    return wrap;
  }

  function syncParseBtn() {
    if (!state.parseBtn) return;
    const ready = state.mode === 'text'
      ? (state.textArea?.value ?? '').trim().length > 0
      : !!state.image;
    state.parseBtn.disabled = !ready;
  }

  function readFile(file) {
    if (!file || !file.type?.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => { state.image = reader.result; state.mode = 'image'; render(); };
    reader.readAsDataURL(file);
  }

  function onGlobalPaste(e) {
    if (!parseImage || state.step !== 'input' || state.mode !== 'image') return;
    const file = e.clipboardData?.files?.[0] ?? e.clipboardData?.items?.find?.((it) => it.type?.startsWith('image/'))?.getAsFile?.();
    if (file) readFile(file);
  }

  async function onParse() {
    if (state.mode === 'text') {
      if ((state.textArea?.value ?? '').trim() === '') return;
      const result = parseImportText(state.textArea.value);
      acceptParseResult(result, state.textArea.value);
      return;
    }
    if (!parseImage || !state.image) return;
    const btn = state.parseBtn;
    btn.disabled = true;
    btn.textContent = '识别中…';
    try {
      const result = await parseImage(state.image, { onProgress: (s) => { btn.textContent = s; } });
      if (result.gridFailed) {
        state.candidates = result.items.map((it) => ({ ...it }));
        state.unparsed = result.unparsed ?? [];
        toast('未能从这张图里认出课表网格，已降级为半自动导入');
        go('semi');
        return;
      }
      acceptParseResult(result, null);
    } catch (err) {
      btn.textContent = '解析';
      btn.disabled = false;
      toast(err?.message ? `识别失败：${err.message}` : '识别失败，可改用文字粘贴或半自动导入');
    }
  }

  function acceptParseResult(result, rawText) {
    if (result.positionLoss) {
      state.candidates = result.items.map((it) => ({ ...it }));
      state.unparsed = result.unparsed ?? [];
      state.lastText = rawText;
      go('loss');
      return;
    }
    state.rows = result.items.map((it) => ({ ...it, checked: it.status === 'ok' }));
    state.unparsed = result.unparsed ?? [];
    markConflicts();
    go('preview');
  }

  function clearImported() {
    const n = loadCourses().filter((c) => c.importedFrom).length;
    if (!confirm(`将删除本空间全部 ${n} 门导入的课程，手动添加的课程不受影响；此操作无法撤销，重新导入即可恢复。确定清除？`)) return;
    const removed = removeImportedCourses();
    toast(`已清除 ${removed.length} 门导入课`);
    onDone?.();
    render();
  }

  // ---------- 丢位提示（来源探测） ----------

  function renderLoss() {
    return h('div', { class: 'imp-loss' },
      h('div', { class: 'imp-loss-notice' }, '这种复制方式丢失了上课时间信息'),
      h('div', { class: 'imp-loss-reasons' },
        h('p', {}, '课程在页面上是按网格绘制的，纯文字复制后只剩"课名+地点"，星期与节次无法还原。'),
        h('p', {}, `已认出 ${state.candidates.length} 门课，两条出路：`),
        h('ul', {},
          h('li', {}, parseImage ? '推荐：切到"图片"模式，直接上传该课表页的截图（本机识别，能还原上课时间）' : '推荐：用电脑浏览器打开教务复制，或用课表 App 的"导出/分享课表"'),
          h('li', {}, '半自动：课程名和地点已帮你填好，只需为每条补选星期和节次'),
        ),
      ),
      h('button', { class: 'btn primary imp-semi-open', type: 'button', onclick: () => go('semi') }, '半自动导入（补选星期/节次）'),
      h('button', { class: 'btn imp-loss-back', type: 'button', onclick: () => go('input') }, '返回修改原文'),
    );
  }

  // ---------- 半自动模式（纳入首期，2026-09-22 裁定） ----------

  function renderSemi() {
    const wrap = h('div', { class: 'imp-semi' },
      h('div', { class: 'imp-hint' }, '识别到的课程需要你补选上课时间'));
    for (const cand of state.candidates) {
      cand.ui = {};
      const daySel = mkSelect([{ v: '', label: '选星期' }, ...WEEK_LABELS.map((l, i) => ({ v: String(i + 1), label: l }))], cand.day ?? '', (v) => { cand.day = v ? Number(v) : null; syncSemi(); });
      const startSel = mkSelect([{ v: '', label: '起始节' }, ...PERIODS.map((p) => ({ v: String(p.section), label: `第${p.section}节` }))], cand.startSection ?? '', (v) => {
        cand.startSection = v ? Number(v) : null;
        if (cand.endSection == null || cand.endSection < (cand.startSection ?? 0)) cand.endSection = cand.startSection;
        cand.ui.endSel.value = String(cand.endSection ?? '');
        syncSemi();
      });
      const endSel = mkSelect([{ v: '', label: '止' }, ...PERIODS.map((p) => ({ v: String(p.section), label: `第${p.section}节` }))], cand.endSection ?? '', (v) => { cand.endSection = v ? Number(v) : null; syncSemi(); });
      cand.ui.endSel = endSel;
      wrap.appendChild(h('div', { class: 'imp-semi-row', 'data-course': cand.name },
        h('span', { class: 'imp-semi-name' }, cand.name),
        cand.room ? h('span', { class: 'imp-semi-room' }, cand.room) : null,
        daySel, startSel, endSel,
      ));
    }
    const next = h('button', { class: 'btn primary imp-semi-next', type: 'button', disabled: true, onclick: semiToPreview }, '进入预览');
    state.semiNext = next;
    wrap.appendChild(next);
    wrap.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => go('input') }, '返回'));
    syncSemi();
    return wrap;
  }

  function syncSemi() {
    const done = state.candidates.filter(isSemiReady).length;
    if (state.semiNext) {
      state.semiNext.disabled = done === 0;
      state.semiNext.textContent = done < state.candidates.length
        ? `进入预览（已补全 ${done}/${state.candidates.length}）`
        : `进入预览（${done} 条）`;
    }
  }

  function isSemiReady(c) {
    return c.name && c.day >= 1 && c.day <= 7 && c.startSection >= 1 && (c.endSection ?? c.startSection) >= c.startSection;
  }

  function semiToPreview() {
    const rows = state.candidates.filter(isSemiReady).map((c) => ({
      ...c, endSection: c.endSection ?? c.startSection, status: 'ok', missing: [], checked: true,
    }));
    const skipped = state.candidates.length - rows.length;
    state.rows = rows;
    markConflicts();
    if (skipped > 0) toast(`${skipped} 条还没补全时间，本次不会导入`);
    go('preview');
  }

  // ---------- 步骤 2：预览确认 ----------

  function renderPreview() {
    const wrap = h('div', { class: 'imp-preview' });
    const list = h('div', { class: 'imp-list' });
    for (const row of state.rows) list.appendChild(previewRow(row));
    wrap.appendChild(list);

    if (state.unparsed.length) {
      wrap.appendChild(h('details', { class: 'imp-unparsed' },
        h('summary', {}, `未能识别的内容（${state.unparsed.length} 行，不静默丢弃）`),
        ...state.unparsed.map((l) => h('div', { class: 'imp-unparsed-line' }, l)),
      ));
    }
    const submit = h('button', { class: 'btn primary imp-confirm', type: 'button', onclick: confirmImport }, '确认导入');
    state.submitBtn = submit;
    wrap.appendChild(submit);
    wrap.appendChild(h('button', { class: 'btn', type: 'button', onclick: () => go('input') }, '返回修改'));
    refreshPreviewState();
    return wrap;
  }

  function previewRow(row) {
    row.ui = {};
    const cb = h('input', { type: 'checkbox', class: 'imp-check', checked: row.checked === true, onchange: (e) => { row.checked = e.target?.checked ?? cb.checked; syncRow(row); } });
    const name = h('input', { class: 'imp-name', value: row.name ?? '', placeholder: '课程名', oninput: (e) => { row.name = e.target?.value ?? name.value; syncRow(row); } });
    const daySel = mkSelect([{ v: '', label: '选星期' }, ...WEEK_LABELS.map((l, i) => ({ v: String(i + 1), label: l }))], row.day ?? '', (v) => { row.day = v ? Number(v) : null; syncRow(row); });
    const startSel = mkSelect([{ v: '', label: '起' }, ...PERIODS.map((p) => ({ v: String(p.section), label: `第${p.section}节` }))], row.startSection ?? '', (v) => {
      row.startSection = v ? Number(v) : null;
      if (row.startSection && (row.endSection ?? 0) < row.startSection) row.endSection = row.startSection;
      row.ui.endSel.value = String(row.endSection ?? '');
      syncRow(row);
    });
    const endSel = mkSelect([{ v: '', label: '止' }, ...PERIODS.map((p) => ({ v: String(p.section), label: `第${p.section}节` }))], row.endSection ?? '', (v) => { row.endSection = v ? Number(v) : null; syncRow(row); });
    const room = h('input', { class: 'imp-room', value: row.room ?? '', placeholder: '地点（选填）', oninput: (e) => { row.room = e.target?.value ?? room.value; syncRow(row); } });
    const colorSel = mkSelect(COURSE_COLORS.map((c) => ({ v: c, label: COLOR_LABELS[c] })), row.color ?? COURSE_COLORS[0], (v) => { row.color = v; syncRow(row); });
    row.ui = { cb, name, daySel, startSel, endSel, room, colorSel, badge: h('span', { class: 'imp-badge' }) };
    return h('div', { class: 'imp-row', 'data-course': row.name ?? '' },
      cb, row.ui.badge, name, daySel, startSel, endSel, room, colorSel,
      row.weeks ? h('span', { class: 'imp-weeks' }, `第${row.weeks.from}-${row.weeks.to}周${row.weeks.parity === 'odd' ? ' 单周' : row.weeks.parity === 'even' ? ' 双周' : ''}`) : null,
      h('button', {
        class: 'btn imp-remove-row', type: 'button', title: '从清单移除（不导入这一条）',
        onclick: () => {
          state.rows = state.rows.filter((r) => r !== row);
          markConflicts();
          go('preview');
        },
      }, '×'),
    );
  }

  function syncRow(row) {
    markConflicts();
    refreshPreviewState();
  }

  function missingOf(r) {
    const missing = [];
    if (!String(r.name ?? '').trim()) missing.push('name');
    if (!(r.day >= 1 && r.day <= 7)) missing.push('day');
    if (!(r.startSection >= 1) || !(r.endSection >= r.startSection)) missing.push('section');
    return missing;
  }

  /** 冲突 = 星期相同 && 节次区间重叠 && 周次有交集（§5.7），对已有课与其他行双向判定。
   *  两阶段：先算每行的"字段齐全"基线，再判定冲突——配对时只看基线，
   *  否则先被标冲突的行会让后面的行漏判（A、B 互撞只 A 中枪的不对称 bug）。 */
  function markConflicts() {
    const rows = state.rows;
    for (const r of rows) {
      r.missing = missingOf(r);
      r.baseOk = r.missing.length === 0;
      r.status = r.baseOk ? 'ok' : 'needsFix';
      r.conflictsWith = null;
    }
    const existing = loadCourses();
    for (const r of rows) {
      if (!r.baseOk) continue;
      let hit = null;
      for (const e of existing) {
        if (sameSlot(r, e)) { hit = e.name; break; }
      }
      if (!hit) {
        for (const o of rows) {
          if (o === r || !o.baseOk) continue;
          if (sameSlot(r, o)) { hit = o.name; break; }
        }
      }
      if (hit) { r.conflictsWith = hit; r.status = 'conflict'; r.checked = false; }
    }
  }

  function sameSlot(a, b) {
    return Number(a.day) === Number(b.day)
      && Number(a.startSection) <= Number(b.endSection) && Number(b.startSection) <= Number(a.endSection)
      && weeksOverlap(a.weeks, b.weeks);
  }

  function refreshPreviewState() {
    for (const r of state.rows) {
      if (!r.ui?.badge) continue;
      const cls = r.status === 'ok' ? 'ok' : r.status === 'conflict' ? 'conflict' : 'fix';
      const label = r.status === 'ok' ? '已识别'
        : r.status === 'conflict' ? `冲突：与「${r.conflictsWith}」重叠`
          : `需修正：缺${r.missing.map((m) => ({ name: '名称', day: '星期', section: '节次' })[m]).join('、')}`;
      r.ui.badge.className = `imp-badge imp-badge-${cls}`;
      r.ui.badge.textContent = label;
      r.ui.cb.disabled = r.status !== 'ok';
      if (r.status !== 'ok') r.checked = false;
    }
    const n = state.rows.filter((r) => r.checked && r.status === 'ok').length;
    if (state.submitBtn) {
      state.submitBtn.textContent = `确认导入 ${n} 门课`;
      state.submitBtn.disabled = n === 0;
    }
  }

  function confirmImport() {
    const chosen = state.rows.filter((r) => r.checked && r.status === 'ok');
    if (!chosen.length) return;
    const built = [];
    try {
      for (const r of chosen) {
        const draft = {
          id: newCourseId(),
          name: String(r.name).trim(),
          day: Number(r.day),
          startSection: Number(r.startSection),
          endSection: Number(r.endSection),
          room: String(r.room ?? '').trim(),
          color: r.color || COURSE_COLORS[0],
          importedFrom: 'import',
          createdAt: Date.now(),
        };
        if (r.weeks) draft.weeks = r.weeks;
        const { ok } = validateCourse(draft, [...loadCourses(), ...built]);
        if (!ok) continue; // 预览已判过冲突，这里只是最后一道保险
        upsertCourse(draft);
        built.push(draft);
      }
    } catch (err) {
      if (err instanceof StoreError) {
        toast(err.message, { duration: 5000 });
        if (built.length) onDone?.();
        return;
      }
      throw err;
    }
    closeOverlay();
    document.removeEventListener?.('paste', onGlobalPaste);
    toast(`已导入 ${built.length} 门课 · 可随时编辑`);
    onDone?.();
  }

  // ---------- 小工具 ----------

  function mkSelect(options, value, onChange) {
    const sel = h('select', { class: 'imp-sel', onchange: (e) => onChange(e.target?.value ?? sel.value) },
      ...options.map((o) => h('option', { value: o.v }, o.label)));
    sel.value = String(value ?? '');
    return sel;
  }

  render();
  return { panel, state, go };
}
