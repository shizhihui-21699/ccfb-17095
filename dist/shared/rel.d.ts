/**
 * rel 属性的分词、合并与剔除工具。
 * rel 是空格分隔的 token 集合，所有操作都按集合处理，避免重复 token。
 */
export declare function splitRel(rel: string | null | undefined): string[];
/** 在已有 rel 上追加必需 token，保持原有顺序，去重 */
export declare function mergeRelTokens(existing: string | null | undefined, required: readonly string[]): string;
/** 剔除指定 token（受信任弹窗需要移除 noopener 时使用） */
export declare function removeRelTokens(existing: string | null | undefined, removed: readonly string[]): string;
export declare function hasRelToken(rel: string | null | undefined, token: string): boolean;
