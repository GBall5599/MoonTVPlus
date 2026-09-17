/**
 * PostCSS 配置。
 *
 * `./postcss-legacy-compat` 是本仓库自有的插件：把 Tailwind 产出的现代 CSS
 * （`:is()` / `:where()` / `:not(a, b)` / `inset:` / 逻辑属性）在**构建期**降级成
 * 老 Chromium 内核（2345、QQ、搜狗等国产双核浏览器的极速内核常见 63~87）
 * 能解析的等价写法。原因见插件文件头的长注释：
 * CSS 遇到不认识的选择器是**丢弃整条规则**，不像 JS 那样只是少个功能。
 *
 * 验证：`node tools/check-legacy-css.mjs`（对构建产物做离线变换并给出前后计数）。
 */
module.exports = {
  plugins: {
    tailwindcss: {},
    './postcss-legacy-compat.js': {},
    autoprefixer: {},
  },
};
