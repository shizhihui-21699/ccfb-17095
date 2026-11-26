/**
 * rel 属性的分词、合并与剔除工具。
 * rel 是空格分隔的 token 集合，所有操作都按集合处理，避免重复 token。
 */
export function splitRel(rel) {
    if (!rel)
        return [];
    const seen = new Set();
    const tokens = [];
    for (const token of rel.trim().split(/\s+/)) {
        const lower = token.toLowerCase();
        if (lower && !seen.has(lower)) {
            seen.add(lower);
            tokens.push(lower);
        }
    }
    return tokens;
}
/** 在已有 rel 上追加必需 token，保持原有顺序，去重 */
export function mergeRelTokens(existing, required) {
    const tokens = splitRel(existing);
    const seen = new Set(tokens);
    for (const token of required) {
        const lower = token.toLowerCase();
        if (!seen.has(lower)) {
            seen.add(lower);
            tokens.push(lower);
        }
    }
    return tokens.join(" ");
}
/** 剔除指定 token（受信任弹窗需要移除 noopener 时使用） */
export function removeRelTokens(existing, removed) {
    const drop = new Set(removed.map((t) => t.toLowerCase()));
    return splitRel(existing)
        .filter((token) => !drop.has(token))
        .join(" ");
}
export function hasRelToken(rel, token) {
    return splitRel(rel).includes(token.toLowerCase());
}
//# sourceMappingURL=rel.js.map