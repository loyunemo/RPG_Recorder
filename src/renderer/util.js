/** 轻量 DOM 工具：够用就好，不引入框架。 */

/**
 * 创建元素。
 *   h('div.card#main', { onclick: fn, style: {color:'red'} }, '文本', 子节点)
 */
export function h(spec, props, ...children) {
  let tag = 'div';
  const classes = [];
  const idMatch = /#([\w-]+)/.exec(spec);
  const tagMatch = /^([\w-]+)/.exec(spec);
  if (tagMatch) tag = tagMatch[1];
  for (const m of spec.matchAll(/\.([\w-]+)/g)) classes.push(m[1]);

  const el = document.createElement(tag);
  if (idMatch) el.id = idMatch[1];
  if (classes.length) el.className = classes.join(' ');

  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  } else if (props != null) {
    children.unshift(props);
  }

  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function render(parent, ...children) {
  clear(parent);
  append(parent, children);
  return parent;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ── 反馈 ── */

let toastTimer = null;
export function toast(message, isError = false) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  clearTimeout(toastTimer);
  const node = h('div.toast' + (isError ? '.err' : ''), {}, message);
  document.body.appendChild(node);
  toastTimer = setTimeout(() => node.remove(), isError ? 4200 : 2400);
}

/** 简易确认框（替代 window.confirm，保持视觉一致） */
export function confirmDialog(title, message, confirmLabel = '确定') {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const close = (v) => { root.innerHTML = ''; resolve(v); };
    const mask = h('div.modal-mask', { onclick: (e) => { if (e.target === mask) close(false); } },
      h('div.modal', { style: { width: 'min(420px, 92vw)' } },
        h('h2', {}, title),
        h('p.sub', {}, message),
        h('div.modal-foot', {},
          h('button.btn', { onclick: () => close(false) }, '取消'),
          h('button.btn.primary', { onclick: () => close(true) }, confirmLabel),
        ),
      ),
    );
    render(root, mask);
  });
}

/* ── 格式化 ── */

export const pad2 = (n) => String(n).padStart(2, '0');

export function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function signed(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

/** 数字输入框（失焦/回车时提交，避免每敲一下都写盘） */
export function numInput(value, onChange, opts = {}) {
  const input = h('input.inline-edit.mono', {
    type: 'number',
    value: value ?? '',
    min: opts.min,
    max: opts.max,
    step: opts.step || 1,
    style: opts.style,
    onchange: (e) => onChange(Number(e.target.value)),
    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
  });
  return input;
}

export function textInput(value, onChange, opts = {}) {
  return h('input.inline-edit', {
    type: 'text',
    value: value ?? '',
    placeholder: opts.placeholder || '',
    onchange: (e) => onChange(e.target.value),
    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
  });
}

export function debounce(fn, ms = 220) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}
