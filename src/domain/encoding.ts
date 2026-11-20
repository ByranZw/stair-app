/** 无DOM的App逻辑层也能生成标准UTF-8；孤立代理项按TextEncoder规则替换为U+FFFD。 */
export function utf8Bytes(text: string): Uint8Array {
  let size = 0
  for (const char of text) {
    const point = char.codePointAt(0)!
    size += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const char of text) {
    let point = char.codePointAt(0)!
    if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd
    if (point < 0x80) bytes[offset++] = point
    else if (point < 0x800) {
      bytes[offset++] = 0xc0 | (point >> 6)
      bytes[offset++] = 0x80 | (point & 0x3f)
    } else if (point < 0x10000) {
      bytes[offset++] = 0xe0 | (point >> 12)
      bytes[offset++] = 0x80 | ((point >> 6) & 0x3f)
      bytes[offset++] = 0x80 | (point & 0x3f)
    } else {
      bytes[offset++] = 0xf0 | (point >> 18)
      bytes[offset++] = 0x80 | ((point >> 12) & 0x3f)
      bytes[offset++] = 0x80 | ((point >> 6) & 0x3f)
      bytes[offset++] = 0x80 | (point & 0x3f)
    }
  }
  return bytes
}
