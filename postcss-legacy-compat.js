/**
 * PostCSS 插件：把 Tailwind 产出的**现代 CSS 写法降级**成老浏览器内核能解析的形式。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────
 * CSS 与 JS 不同：**遇到不认识的选择器，浏览器会丢弃整条规则**（不是忽略选择器，
 * 是整条规则连同里面的所有声明一起没了）。所以下面这些在 2345 浏览器这类
 * 老 Chromium 内核（63~87）上会成片失效，而不是"退化成没有样式"：
 *
 *   · `:is(...)` / `:where(...)`        —— Chrome 88+；Tailwind v3.4 的 `dark:` 变体
 *                                          被编译成 `.dark\:x:is(.dark *)`，
 *                                          于是**深色模式的样式整片消失**
 *   · `:not(a, b)`（选择器列表）        —— Chrome 88+
 *   · `inset: 0`                        —— Chrome 87+；全站 4 条，含 `.inset-0`
 *   · `*-inline-start/end`（逻辑属性）  —— Chrome 87+
 *
 * 解决办法不是"少用这些写法"（Tailwind 生成什么我们控制不了），而是**在构建期
 * 把它们改写成等价的旧写法**：
 *
 *   `SEL:is(.dark *)`      →  `.dark SEL`            （特异性不变：:is() 取内部最高）
 *   `:where(X)`            →  `X`                     （仅去外壳，见下方说明）
 *   `:not(a, b)`           →  `:not(a):not(b)`        （语义与特异性都等价）
 *   `inset: v`             →  `top:v;right:v;bottom:v;left:v` + 原声明
 *   `padding-inline-start` →  `padding-left`（LTR）+ 原声明
 *
 * 为什么 `:where()` 可以直接去外壳：`:where()` 的意义是"特异性归零"，用它的是
 * Tailwind 的 preflight 与 typography 插件。去掉外壳会略微抬高特异性，但那两类
 * 规则本来就在"最底层"（preflight 在 base 层、prose 靠 .prose 前缀），
 * 实际影响是 md 正文里的写法和默认表单样式能正常生效 —— 老内核上本来是全丢。
 *
 * 为什么不顺手处理 `aspect-ratio`：它没法用等价比替换（需要 padding 占位 hack，
 * 且对 `<img>` 与 flex 容器行为不同）。那部分单独写在 `globals.css` 的
 * `@supports not (...)` 块里，见文件末尾「老内核兜底」一节。
 *
 * 验证：`node tools/audit-legacy-compat.mjs`（本插件生效后，:is/:where/inset
 * 的命中数应显著下降；`--dir` 指向构建产物即可）。
 */

/** 能匹配一层嵌套括号的伪类参数（够用：我们的场景最多一层）。 */
const ARG = String.raw`\(([^()]*(?:\([^()]*\)[^()]*)*)\)`;

const DARK_FORMS = [
  new RegExp(String.raw`:is\(\.dark \*\)`, 'g'),
  new RegExp(String.raw`:where\(\.dark, \.dark \*\)`, 'g'),
  new RegExp(String.raw`:is\(\.dark, \.dark \*\)`, 'g'),
];

const RE_NOT_LIST = new RegExp(String.raw`:not${ARG}`, 'g');
const RE_WHERE = new RegExp(String.raw`:where${ARG}`, 'g');
const RE_IS = new RegExp(String.raw`:is${ARG}`, 'g');

/** 逻辑属性 → 物理属性（本站只有 LTR，足够）。 */
const LOGICAL_LONGHAND = [
  [/^margin-inline-start$/, 'margin-left'],
  [/^margin-inline-end$/, 'margin-right'],
  [/^padding-inline-start$/, 'padding-left'],
  [/^padding-inline-end$/, 'padding-right'],
  [/^border-inline-start-width$/, 'border-left-width'],
  [/^border-inline-start-color$/, 'border-left-color'],
  [/^border-inline-start-style$/, 'border-left-style'],
  [/^border-inline-end-width$/, 'border-right-width'],
  [/^border-inline-end-color$/, 'border-right-color'],
  [/^border-inline-end-style$/, 'border-right-style'],
];

/** 按**顶层逗号**切分（忽略嵌套括号里的逗号）——`:not(a, b)` 的参数切分必须这样。 */
function splitTopLevel(str) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

function unwrapOne(sel) {
  let prev;
  let guard = 0;
  do {
    prev = sel;
    // 1) :where(x) → x —— 去掉"特异性归零"的外壳（老内核不认，会丢整条规则）
    sel = sel.replace(RE_WHERE, '$1');
    // 2) :is(x) → x —— 仅单备选；多备选交给 expandIsAlternatives 拆规则
    sel = sel.replace(RE_IS, (m, inner) => (splitTopLevel(inner).length > 1 ? m : inner));
    // 3) :not(a, b) → :not(a):not(b)（语义与特异性等价，Chrome 47 起就支持多段 :not）
    sel = sel.replace(RE_NOT_LIST, (m, inner) => {
      const parts = splitTopLevel(inner);
      if (parts.length < 2) return m;
      return parts.map((s) => `:not(${s})`).join('');
    });
  } while (sel !== prev && ++guard < 24);
  return sel;
}

/**
 * 把剩下的 `:is(a, b)`（多备选）按备选**拆成多条选择器**。
 * `X:is(a, b) Y` → `X a Y` / `X b Y`；多个 :is 取笛卡尔积（封顶 32 条防爆）。
 */
function expandIsAlternatives(selector, depth = 0) {
  if (depth > 4) return [selector];
  const m = selector.match(new RegExp(String.raw`:is${ARG}`));
  if (!m) return [selector];
  const alts = splitTopLevel(m[1]);
  if (alts.length < 2) return [selector];
  const out = [];
  for (const alt of alts) {
    for (const expanded of expandIsAlternatives(selector.replace(m[0], alt), depth + 1)) {
      out.push(expanded);
      if (out.length > 32) return out;
    }
  }
  return out.length ? out : [selector];
}

function lowerSelector(selector) {
  let out = selector;
  let dark = false;
  for (const re of DARK_FORMS) {
    if (re.test(out)) {
      dark = true;
      // 只摘掉这一个伪类，并用**单个空格**补位（保持 token 之间原有关系）。
      // ⚠ 千万不要在这里做"给组合符补空格"之类的美化：属性选择器里的
      // `[class~=not-prose]` 含 `~`，会被误改写成 `[class ~ =not-prose]`，
      // 选择器直接失效（这个坑踩过一次）。
      out = out.replace(new RegExp(re.source, 'g'), ' ');
    }
  }
  out = unwrapOne(out);
  out = out.replace(/\s{2,}/g, ' ').trim();
  if (dark) out = `.dark ${out}`.trim();
  return out;
}

module.exports = (opts = {}) => {
  const enabled = opts.enabled !== false;
  const stats = opts.stats || null;
  return {
    postcssPlugin: 'postcss-legacy-compat',
    OnceExit(root) {
      if (!enabled) return;
      let selectorHits = 0;
      let expandedHits = 0;
      let insetHits = 0;
      let logicalHits = 0;
      let valueFallbackHits = 0;

      root.walkRules((rule) => {
        // --- 选择器降级 ---
        if (rule.selector && /:is\(|:where\(|:not\([^()]*,/.test(rule.selector)) {
          const raw = rule.selectors;
          let lowered = raw.map(lowerSelector);

          // `:is(a, b)` 这类多备选：老内核同样丢弃整条规则，按备选**拆成多条规则**。
          if (lowered.some((s) => /:is\([^()]*,/.test(s))) {
            const expanded = [];
            for (const sel of lowered) {
              expanded.push(...expandIsAlternatives(sel));
            }
            lowered = expanded.length && expanded.length <= 32 ? expanded : lowered;
            if (lowered.length > 1) expandedHits += 1;
          }

          const deduped = [...new Set(lowered)];
          const next = deduped.join(', ');
          if (next !== rule.selector) {
            if (deduped.length > 1 && rule.selectors.length === 1) {
              // 一条变多条：复制规则，保持源顺序（@media 内也安全）
              const extra = deduped.slice(1);
              rule.selector = deduped[0];
              let anchor = rule;
              for (const sel of extra) {
                const clone = rule.cloneAfter({ selector: sel });
                anchor = clone;
              }
            } else {
              rule.selector = next;
            }
            selectorHits += 1;
          }
        }

        // --- 声明降级 ---
        rule.walkDecls((decl) => {
          if (decl.prop === 'inset' && !decl.value.includes('var(')) {
            const v = decl.value;
            for (const side of ['top', 'right', 'bottom', 'left']) {
              decl.cloneBefore({ prop: side, value: v });
            }
            insetHits += 1;
            return;
          }
          if (decl.prop === 'inset-inline' || decl.prop === 'inset-block') {
            const parts = decl.value.split(/\s+/);
            const [a, b] = parts.length === 1 ? [parts[0], parts[0]] : parts;
            const sides =
              decl.prop === 'inset-inline' ? ['left', 'right'] : ['top', 'bottom'];
            decl.cloneBefore({ prop: sides[0], value: a });
            decl.cloneBefore({ prop: sides[1], value: b });
            insetHits += 1;
            return;
          }
          if (
            (decl.prop === 'margin-inline' || decl.prop === 'padding-inline') &&
            !decl.value.includes('var(')
          ) {
            const parts = decl.value.split(/\s+/);
            const [a, b] = parts.length === 1 ? [parts[0], parts[0]] : parts;
            const base = decl.prop.split('-')[0];
            decl.cloneBefore({ prop: `${base}-left`, value: a });
            decl.cloneBefore({ prop: `${base}-right`, value: b });
            logicalHits += 1;
            return;
          }
          for (const [re, phys] of LOGICAL_LONGHAND) {
            if (re.test(decl.prop)) {
              decl.cloneBefore({ prop: phys, value: decl.value });
              logicalHits += 1;
              return;
            }
          }

          // 视口单位：dvh/svh/lvh 要 Chrome 108+，老内核会把整条声明丢掉
          // （丢 h-[92dvh] 就等于没有高度）。补一条 vh 版本兜底。
          if (/(\d)(dvh|svh|lvh)\b/.test(decl.value)) {
            decl.cloneBefore({
              value: decl.value.replace(/(\d)(dvh|svh|lvh)\b/g, '$1vh'),
            });
            valueFallbackHits += 1;
            return;
          }

          // overflow: clip 要 Chrome 90+，退化成 hidden（视觉近似）
          if (decl.prop === 'overflow' && decl.value.trim() === 'clip') {
            decl.cloneBefore({ value: 'hidden' });
            valueFallbackHits += 1;
          }
        });
      });

      const summary = {
        selectorsLowered: selectorHits,
        selectorsExpanded: expandedHits,
        insetExpanded: insetHits,
        logicalExpanded: logicalHits,
        valueFallbacks: valueFallbackHits,
      };
      if (stats) Object.assign(stats, summary);

      if (process.env.LEGACY_CSS_VERBOSE === '1') {
        console.log(
          `[postcss-legacy-compat] 选择器降级 ${selectorHits} 条（展开多备选 ${expandedHits} 条）/ inset 补物理属性 ${insetHits} 处 / 逻辑属性 ${logicalHits} 处 / 值兜底 ${valueFallbackHits} 处`
        );
      }
    },
  };
};

module.exports.postcss = true;
