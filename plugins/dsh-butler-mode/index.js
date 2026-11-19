/**
 * @local/dsh-butler-mode（Host 半）
 *
 * 大管家模式没有宿主侧逻辑：人设在 profile patch 的 preset-butler（dsh-agent-preset），
 * 派单工具由官方 dsh-experimental-tool-agent-team 提供。这里只保留一个空 Host 半，
 * 让包有 "." 导出（装载器需要），客户端逻辑全在 client.js。
 */
export function apply() {}
