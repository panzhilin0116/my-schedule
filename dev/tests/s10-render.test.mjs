// S10 的界面部分：C19 六页空态引导、C18 断网错误态与重试（且不留未捕获异常）、
// 统一加载骨架、浮层焦点管理（进层停首字段、Tab 在层内循环、关闭还原焦点）、
// C2 的键盘路径（只用焦点+输入+回车就能记一条待办）、图标按钮的中文名补齐。
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewServer } from '../preview-server.mjs';
import { createApi } from '../../web/lib/api.js';
import { read } from './helpers.mjs';
import {
  withDom, seedState, emptyAppState, liveCtx, fakeCtx, texts, viewRenders, viewArgs,
  TODAY, settle, waitUntil, app, intervals, emitWindow, topTitle, go, toastTexts,
} from './render-harness.mjs';

// 晚到的重绘会砸在已还原的全局上，只报一句 "document is not defined"。把栈打出来才查得到是谁。
process.on('uncaughtException', (error) => console.error('LEAK-STACK', error?.stack));

const FOCUSABLE = 'input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),a[href]';
const tabbable = (root) => root.querySelectorAll('input,select,textarea,button,a[href]')
  .filter((node) => !node.hidden && !node.disabled);

const VIEW_KEYS = ['home', 'timetable', 'tasks', 'research', 'workout', 'settings'];

// ── C19：清空状态后六页都是引导，不是空白 ──────────────────

test('S10 C19：六个页面在空库下各自给出中文引导与入口', async () => {
  const views = await viewRenders();
  await withDom(async () => {
    for (const key of VIEW_KEYS) {
      const state = emptyAppState();
      const node = views[key](viewArgs[key](state, fakeCtx().ctx));
      const empties = node.querySelectorAll('.empty');
      assert.ok(empties.length > 0, `${key}：清空状态下一片空白，没有空态引导`);
      const titles = empties.map((box) => box.querySelector('p')?.textContent.trim() ?? '');
      assert.ok(titles.every((title) => title.length > 1), `${key}：空态没有一句话说明：${titles.join('|')}`);
      const guided = empties.filter((box) => texts(box.querySelector('p.tiny.faint') ?? box).trim()
        || box.querySelector('button.btn, a.btn'));
      assert.equal(guided.length, empties.length, `${key}：空态只说了"没有"，没给下一步）`);
      assert.equal(/undefined|null|NaN/.test(texts(node)), false, `${key}：空态里漏出了程序字样`);
    }
  });
});

test('S10 C19：首页四张卡在空库里都有读数与引导，不留裸空格', async () => {
  await withDom(async () => {
    const { renderHome } = await import('../../web/views/home.js');
    const node = renderHome(viewArgs.home(emptyAppState(), fakeCtx().ctx));
    const cards = node.querySelectorAll('.home-grid .panel');
    assert.equal(cards.length, 4);
    for (const card of cards) {
      assert.ok(texts(card.querySelector('.panel-head h3')).trim().length > 1, '卡片要有名字');
      const body = card.children.at(-1);
      assert.ok(texts(body).trim().length > 3, `${card.querySelector('.panel-head h3').textContent} 卡体是空的`);
    }
    assert.match(texts(node.querySelector('.readout .week')), /未设置学期|学期/);
    assert.match(texts(cardOf(node, 'workouts').querySelector('.quick-read')), /去健身页记第一笔/);
  });
});

const cardOf = (node, key) => node.querySelectorAll('.home-grid .panel')
  .find((item) => item.dataset.card === key);

// ── C18：断网错误态与重试 ─────────────────────────────────

test('S10 C18：断网打开应用是可读错误态，恢复后点重试就回来', async () => {
  const server = createPreviewServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const realFetch = globalThis.fetch;
  const rejections = [];
  const onRejection = (reason) => rejections.push(String(reason?.message ?? reason));
  process.on('unhandledRejection', onRejection);
  try {
    await withDom(async () => {
      // 手机进电梯：连不上站点，然后再走出来点一次重试
      globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
      app.start();
      assert.equal(await waitUntil(() => app.store.state.status === 'error'), true, '断网启动没有落到错误态');
      const view = document.getElementById('view');
      const error = view.querySelector('.empty');
      assert.ok(error, '加载失败没有显示错误态');
      assert.equal(error.getAttribute('role'), 'alert', '错误要当场念给读屏用户');
      const message = error.querySelector('p').textContent;
      assert.match(message, /网络|连接|刷新/, `错误文案太技术化：${message}`);
      assert.equal(/Error|failed|fetch|undefined/i.test(message), false, `错误文案里漏出英文异常：${message}`);
      assert.match(texts(error.querySelector('p.tiny.faint')), /数据还在服务器上/);
      const retry = error.querySelectorAll('button').find((node) => node.textContent === '重试');
      assert.ok(retry, '错误态没有重试按钮');
      // 错误态本身就是这一屏，导航与顶栏仍要在位（不是白屏）
      assert.ok(document.getElementById('rail').querySelectorAll('a').length >= 5);
      assert.equal(topTitle(), '任务舱');

      globalThis.fetch = (input, init) => realFetch(String(input).startsWith('http') ? input : `${origin}${input}`, init);
      retry.click();
      assert.equal(await waitUntil(() => app.store.state.status === 'ready' && app.store.state.inflight === 0, 9000), true, '点了重试还停在错误态');
      assert.equal(app.store.state.error, null);
      assert.equal(view.querySelector('.empty[role="alert"]'), null, '恢复后错误态要撤掉');
      assert.ok(texts(view.querySelector('.hud')).includes('第 '), '恢复后直接读到首页数据，不必刷新页面');
    });
  } finally {
    process.off('unhandledRejection', onRejection);
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(rejections, [], `断网期间冒出了未捕获的 Promise 异常：${rejections.join(' | ')}`);
});

test('S10 C18：断网时写请求只发一次，失败后回读确认而不自动重放', async () => {
  const server = createPreviewServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/functions/v1/app`;
  const realFetch = globalThis.fetch;
  const rejections = [];
  const onRejection = (reason) => rejections.push(String(reason?.message ?? reason));
  process.on('unhandledRejection', onRejection);
  let online = true;
  let writes = 0;
  let reads = 0;
  const fetchImpl = async (input, init) => {
    if (init?.method === 'POST') writes += 1; else reads += 1;
    if (!online) throw new TypeError('Failed to fetch');
    return realFetch(String(input), init);
  };
  try {
    const { createStore } = await import('../../web/lib/store.js');
    const store = createStore({ api: createApi({ baseUrl, fetchImpl }) });
    await store.load();
    assert.equal(store.state.status, 'ready');
    writes = 0;
    reads = 0;
    online = false;
    await assert.rejects(() => store.create('tasks', { title: '断网时记的一条', due_date: TODAY }), (error) => {
      assert.equal(error.code, 'network_error');
      assert.match(error.message, /网络|刷新确认/);
      return true;
    });
    assert.equal(store.state.writeError?.unknown, true, '写入结果未知时不能装作"失败可以安全重发"');
    assert.equal(writes, 1, '写请求被自动重放了');
    assert.equal(reads, 1, '失败后只应做一次回读确认');
    await settle(30);
    assert.equal(writes, 1, '过一会儿又补发了写请求');
    assert.equal(reads, 1, '回读变成了轮询重放');
    // 有缓存可读时不清屏：错误以提示条呈现，界面继续能用
    assert.equal(store.state.status, 'ready');
    assert.equal(store.row('tasks', 'nope'), null);
  } finally {
    process.off('unhandledRejection', onRejection);
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(rejections, [], `断网期间冒出了未捕获的 Promise 异常：${rejections.join(' | ')}`);
});

/** C18 的延伸路径：数据已经读到手之后才断网（切前台、下拉刷新、点刷新都不再是首屏）。 */
test('S10 C18 延伸：读到数据后同步失败，界面继续可读并当场说明，不谎报"已同步"', async () => {
  const server = createPreviewServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  const rejections = [];
  const onRejection = (reason) => rejections.push(String(reason?.message ?? reason));
  process.on('unhandledRejection', onRejection);
  try {
    await withDom(async () => {
      globalThis.fetch = (input, init) => realFetch(String(input).startsWith('http') ? input : `${origin}${input}`, init);
      app.start();
      assert.equal(await waitUntil(() => app.store.state.status === 'ready' && app.store.state.inflight === 0, 9000), true, '没能在断网前拿到数据');
      const view = document.getElementById('view');
      const hudBefore = texts(view.querySelector('.hud'));
      assert.ok(hudBefore.length > 1, '首页读数没渲染出来，这条用例就成了空转');

      globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
      // 真实控件：顶栏「刷新数据」
      const refresh = document.getElementById('topbar').querySelector('button[aria-label="刷新数据"]');
      assert.ok(refresh, '顶栏没有刷新按钮');
      refresh.click();
      assert.equal(await waitUntil(() => app.store.state.error?.stale === true, 9000), true, '回读失败没有留下陈旧标记');

      assert.equal(app.store.state.status, 'ready', `同步失败把状态打回了 ${app.store.state.status}`);
      assert.equal(view.querySelector('.skeleton'), null, '同步失败把有数据的界面打回了骨架屏');
      assert.equal(view.querySelector('.empty[role="alert"]'), null, '有旧数据可读时不该整屏换成错误态');
      assert.equal(texts(view.querySelector('.hud')), hudBefore, '旧数据被清掉了');
      const stale = document.getElementById('topbar').querySelector('.stale');
      assert.ok(stale, '同步失败在界面上没有任何回执，用户会以为看到的还是最新的');
      assert.match(stale.textContent, /同步失败|未同步|离线/, `陈旧提示文案不清楚：${texts(stale)}`);
      assert.equal(stale.getAttribute('role'), 'status', '这个回执要当场念给读屏用户');

      // 下拉刷新同样不能给出成功回执
      view.fire('touchstart', { touches: [{ clientY: 0 }] });
      view.fire('touchmove', { touches: [{ clientY: 100 }] });
      view.fire('touchend', { changedTouches: [{ clientY: 100 }] });
      assert.equal(await waitUntil(() => toastTexts().length > 0, 9000), true, '下拉刷新没有任何反馈');
      assert.equal(toastTexts().some((line) => /已同步最新数据/.test(line)), false, `同步失败却说"已同步最新数据"：${toastTexts().join(' | ')}`);
      assert.equal(toastTexts().some((line) => /同步失败|网络|不是最新/.test(line)), true, `下拉刷新的失败回执不清楚：${toastTexts().join(' | ')}`);

      // 恢复网络后一次成功回读要把回执撤掉
      globalThis.fetch = (input, init) => realFetch(String(input).startsWith('http') ? input : `${origin}${input}`, init);
      document.getElementById('topbar').querySelector('button[aria-label="刷新数据"]').click();
      assert.equal(await waitUntil(() => app.store.state.error === null, 9000), true, '恢复网络后陈旧标记还挂着');
      assert.equal(document.getElementById('topbar').querySelector('.stale'), null, '恢复后提示条要撤掉');
    });
  } finally {
    process.off('unhandledRejection', onRejection);
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(rejections, [], `同步失败期间冒出了未捕获的 Promise 异常：${rejections.join(' | ')}`);
});

// ── 统一加载骨架 ──────────────────────────────────────────

test('S10 加载骨架：首次进入用同一套原语，且不被读屏逐条念出', async () => {
  await withDom(async () => {
    const { skeleton } = await import('../../web/lib/ui.js');
    const stub = skeleton(3);
    assert.equal(stub.querySelectorAll('.skeleton').length, 3);
    assert.equal(stub.querySelectorAll('.skeleton').every((node) => node.getAttribute('aria-hidden') === 'true'), true);
    assert.equal(texts(stub).trim(), '', '骨架不该带任何文字');
  });
  const source = await read('../../web/app.js');
  assert.match(source, /skeleton\(1, 92\), skeleton\(3\)/, '外壳要改用同一套骨架原语，别再手写一套');
  assert.match(source, /errorState\(/, '外壳的错误态也要走原语');
});

// ── 焦点管理 ──────────────────────────────────────────────

test('S10 焦点：打开浮层停在第一个字段，Tab 在层内首尾相扣，关闭回到原处', async () => {
  await withDom(async () => {
    const { openLayer, fieldsFor, closeTopLayer, layerIsOpen } = await import('../../web/lib/ui.js');
    const opener = document.createElement('button');
    opener.textContent = '新增日程';
    document.body.appendChild(opener);
    opener.focus();

    const layer = openLayer({
      title: '新增日程',
      fields: fieldsFor('tasks', { only: ['title', 'due_date', 'duration_min'] }),
      values: {},
      onSubmit: async () => {},
    });
    assert.equal(document.activeElement.id, 'f_title', '要把光标停在第一个字段，而不是关闭按钮');
    const items = tabbable(layer.element);
    assert.deepEqual(items.map((node) => node.id || node.textContent.trim()).slice(0, 3),
      ['', 'f_title', 'f_due_date'], 'Tab 顺序要先过字段');
    assert.equal(items.at(-1).textContent.trim(), '取消', '保存按钮此时是禁用的，不该进 Tab 序列');

    items.at(-1).focus();
    layer.element.fire('keydown', { key: 'Tab' });
    assert.equal(document.activeElement, items[0], '最后一项再按 Tab 要绕回浮层开头');
    layer.element.fire('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(document.activeElement, items.at(-1), '第一项 Shift+Tab 要绕到浮层末尾');
    // 焦点在中间时不拦浏览器自己的 Tab
    items[1].focus();
    layer.element.fire('keydown', { key: 'Tab' });
    assert.equal(document.activeElement, items[1], '中间位置的 Tab 要交还给浏览器');

    closeTopLayer();
    assert.equal(layerIsOpen(), false);
    assert.equal(document.activeElement, opener, '关闭浮层要把焦点还给打开它的那个按钮');
  });
});

test('S10 焦点：删除确认默认停在「返回」上，回车不会顺手删掉东西', async () => {
  await withDom(async () => {
    const { confirmDialog } = await import('../../web/lib/ui.js');
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const dialog = confirmDialog({ title: '删除这条日程', message: '删掉后 5 秒内可以撤销' });
    const focused = document.activeElement;
    assert.equal(focused.textContent.trim(), '返回', '焦点要落在安全的那一侧');
    assert.equal(focused.classList.contains('danger'), false);
    focused.click();
    assert.equal(await dialog, false, '光标停在返回上，回车就把它关掉');
    assert.equal(document.activeElement, opener, '确认框关闭后焦点要回到列表');

    const second = confirmDialog({ title: '清空全部数据', message: '这一步不可撤销', requireText: 'DELETE_ALL' });
    assert.equal(document.activeElement.localName, 'input', '要输入确认字样时，光标该停在那个字段的输入框里');
    assert.equal(document.getElementById('modal-root').querySelector('.btn.danger').disabled, true, '没照抄字样之前删除按钮不能解锁');
    document.activeElement.value = 'DELETE_ALL';
    document.activeElement.fire('input');
    assert.equal(document.getElementById('modal-root').querySelector('.btn.danger').disabled, false);
    document.getElementById('modal-root').querySelector('.btn.danger').click();
    assert.equal(await second, true);
  });
});

// ── C2 键盘路径：只用键盘记一条待办 ────────────────────────

test('S10 C2：只用键盘也能记一条待办——空态入口 → Tab 过字段 → 回车保存', async () => {
  await withDom(async () => {
    const { renderTasks } = await import('../../web/views/tasks.js');
    const { layerIsOpen } = await import('../../web/lib/ui.js');
    const state = emptyAppState();
    const { ctx } = liveCtx(state);
    const node = renderTasks(viewArgs.tasks(state, ctx));
    document.getElementById('view').appendChild(node);

    const entry = node.querySelectorAll('.empty button').find((item) => item.textContent === '新增第一条');
    assert.ok(entry, '空态没给新建入口');
    entry.focus();
    entry.click(); // 键盘上的等价动作是回车：桩里 click 会连带触发关联表单提交
    assert.equal(layerIsOpen(), true);
    assert.equal(document.activeElement.id, 'f_title', '新建浮层要把光标放在标题上');

    const type = (id, value) => {
      const field = document.getElementById(id);
      field.focus();
      field.value = value;
      field.fire('input');
    };
    type('f_title', '键盘新建的待办');
    type('f_due_date', TODAY);
    const layer = document.getElementById('modal-root').querySelector('.layer');
    const submit = [...tabbable(layer)].at(-1);
    assert.equal(submit.textContent.trim(), '加入日程');
    assert.equal(submit.disabled, false, '必填填齐后保存按钮要解锁');
    assert.equal(document.getElementById('f_due_time').hasAttribute('required'), false, '可选字段不该拦路');
    submit.focus();
    submit.click(); // 等价于在字段里按回车
    await settle(8);
    assert.equal(state.tables.tasks.length, 1, '键盘路径没能写入');
    assert.equal(state.tables.tasks[0].title, '键盘新建的待办');
    assert.equal(state.tables.tasks[0].due_date, TODAY);
    assert.equal(layerIsOpen(), false, '保存成功后浮层要收掉');
    assert.equal(document.activeElement, entry, '回到列表后焦点要还给入口按钮');
    // 列表要跟着新数据重画一遍，才谈得上"写完了看得见"
    assert.match(texts(renderTasks(viewArgs.tasks(state, ctx))), /键盘新建的待办/);
  });
});

// ── 图标按钮的中文名 ──────────────────────────────────────

test('S10 无障碍：每个图标按钮与图标链接都有中文可名', async () => {
  const views = await viewRenders();
  await withDom(async () => {
    const suspects = [];
    const audit = (root, where) => {
      for (const node of [...root.querySelectorAll('button'), ...root.querySelectorAll('a')]) {
        const name = (node.getAttribute('aria-label') ?? '').trim() || node.textContent.trim()
          || (node.getAttribute('title') ?? '').trim();
        if (!name) suspects.push(`${where} <${node.localName} class="${node.className}">`);
      }
    };
    for (const key of VIEW_KEYS) {
      const state = seedState(TODAY);
      audit(views[key](viewArgs[key](state, fakeCtx().ctx)), key);
    }
    const { openLayer, fieldsFor, confirmDialog, toast, closeTopLayer } = await import('../../web/lib/ui.js');
    openLayer({ title: '新增日程', fields: fieldsFor('tasks', { only: ['title'] }), onSubmit: async () => {} });
    audit(document.getElementById('modal-root'), '浮层表单');
    closeTopLayer();
    confirmDialog({ title: '删除', message: '确认吗' });
    audit(document.getElementById('modal-root'), '确认框');
    closeTopLayer();
    toast('已保存', { kind: 'error', duration: 0 });
    audit(document.getElementById('toast-root'), '提示条');
    assert.deepEqual(suspects, [], '这些控件只有图标，读屏念不出名字');
  });
});

// ── 外壳：定时重绘不打断用户 ──────────────────────────────

test('S10 外壳：正在填写或浮层开着时，跨天重绘先让路，空下来再补上', async () => {
  const server = createPreviewServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  const realNow = Date.now();
  try {
    await withDom(async () => {
      globalThis.fetch = (input, init) => realFetch(String(input).startsWith('http') ? input : `${origin}${input}`, init);
      app.start();
      // 收尾的回读要在这里落地：withDom 之后 document 就没了，晚到的重绘会砸在空全局上
      assert.equal(await waitUntil(() => app.store.state.status === 'ready' && app.store.state.inflight === 0, 9000), true, '外壳没有把数据回读落地');
      await go('#/tasks');
      const view = document.getElementById('view');
      const dayTick = intervals.find((item) => item.ms === 30000);
      assert.ok(dayTick, '没有注册跨天重算的定时');
      const at = (days, run) => {
        mock.timers.enable({ apis: ['Date'], now: realNow + days * 86400000 });
        try {
          run();
        } finally {
          mock.reset();
        }
      };

      const input = view.querySelector('input');
      assert.ok(input, '日程页没有快速添加输入框，这一轮断言等于空转');
      input.value = '写到一半的一条';
      input.focus();
      let painted = view.children[0];
      at(1, () => dayTick.handler());
      assert.equal(view.children[0], painted, '焦点在填写框里时不该换掉整屏');
      assert.equal(document.activeElement, input, '定时重绘不能把光标抢走');
      assert.equal(view.querySelector('input').value, '写到一半的一条', '重绘还会把没保存的草稿清掉');

      // 浮层开着时同理：草稿在浮层里，整屏重绘会把浮层之外的读数打乱
      emitWindow('keydown', { key: 'n' });
      assert.equal(document.getElementById('modal-root').children.length, 1, 'N 键没打开新增浮层');
      at(2, () => dayTick.handler());
      assert.equal(view.children[0], painted, '浮层开着时定时重绘要让路');
      emitWindow('keydown', { key: 'Escape' });
      assert.equal(document.getElementById('modal-root').children.length, 0, 'Esc 要能关掉浮层');

      document.body.focus();
      at(2, () => dayTick.handler());
      assert.notEqual(view.children[0], painted, '空下来以后跨天的重绘要补上');
      painted = view.children[0];
      at(2, () => dayTick.handler());
      assert.equal(view.children[0], painted, '同一天里不该反复重绘');
    });
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});
