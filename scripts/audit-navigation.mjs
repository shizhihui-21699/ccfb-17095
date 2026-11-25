#!/usr/bin/env node
/**
 * 导航安全静态审计（零额外依赖，直接使用项目里的 typescript 解析 AST）。
 *
 * 目的：让“统一入口”不只是约定 —— CI 中阻止新的裸 window.open / 不安全
 * target="_blank" 锚点进入代码库。
 *
 * 豁免方式（必须写明原因，code review 时可见）：
 *   // safe-navigation-allow: 这里是统一封装本身
 *   或文件顶部包含 safe-navigation-allow-file
 *
 * 退出码：发现违规为 1，否则 0。
 */

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src', 'demo'];
const EXTENSIONS = new Set(['.ts', '.tsx']);

/** 统一封装实现文件：允许调用底层 window.open。 */
const FILE_ALLOW = new Set([
  path.join('src', 'client', 'safe-open.ts'),
  path.join('src', 'client', 'popup-channel.ts'),
]);

const violations = [];

function walk(dir, out = []) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'public') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

function hasAllowComment(sourceFile, node, text) {
  // 文件级豁免
  if (/safe-navigation-allow-file/.test(text.slice(0, 1200))) return true;
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
  const lines = text.split(/\r?\n/);
  const sameLine = lines[line] ?? '';
  const prevLine = lines[line - 1] ?? '';
  return /safe-navigation-allow/.test(sameLine) || /safe-navigation-allow/.test(prevLine);
}

function isWindowOpenCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const expr = node.expression;
  // window.open(...) / window['open'](...)
  if (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === 'open' &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'window'
  ) {
    return true;
  }
  // globalThis.open(...)
  if (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === 'open' &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'globalThis'
  ) {
    return true;
  }
  return false;
}

function auditFile(file) {
  const rel = path.relative(root, file);
  if (FILE_ALLOW.has(rel)) return;

  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  const visit = (node) => {
    if (isWindowOpenCall(node) && !hasAllowComment(sourceFile, node, text)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push(`${rel}:${line + 1}:${character + 1} 裸 window.open 必须改用 openExternal/openTrustedPopup，或加 safe-navigation-allow 注释说明`);
    }

    // JSX：<a target="_blank" ...> 且字面量 rel 不含 noopener
    if (
      ts.isJsxOpeningElement?.(node) &&
      node.tagName.getText(sourceFile) === 'a'
    ) {
      const attrs = node.attributes.properties;
      let targetBlank = false;
      let relLiteral = null;
      for (const attr of attrs) {
        if (!ts.isJsxAttribute(attr) || !attr.name) continue;
        const name = attr.name.getText(sourceFile);
        if (name === 'target' && attr.initializer) {
          const v = attr.initializer.getText(sourceFile).replace(/^["']|["']$/g, '');
          if (v === '_blank') targetBlank = true;
        }
        if (name === 'rel' && attr.initializer && ts.isStringLiteral(attr.initializer)) {
          relLiteral = attr.initializer.text;
        }
      }
      if (targetBlank && (relLiteral == null || !/\bnoopener\b/.test(relLiteral))) {
        if (!hasAllowComment(sourceFile, node, text)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push(`${rel}:${line + 1}:${character + 1} <a target="_blank"> 必须使用 SafeLink 或设置 rel~"noopener"`);
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

for (const dir of SCAN_DIRS) {
  for (const file of walk(path.join(root, dir))) auditFile(file);
}

if (violations.length) {
  console.error('❌ 导航安全审计未通过：\n');
  for (const v of violations) console.error('  ' + v);
  console.error(`\n共 ${violations.length} 处。统一入口：openExternal / openTrustedPopup / <SafeLink>。`);
  process.exit(1);
}
console.log('✅ 导航安全审计通过：未发现未授权的 window.open 或不安全 target="_blank"。');
