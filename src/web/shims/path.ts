/** path shim — posix 스타일 최소 구현 (웹 가상 경로용) */

export function join(...parts: string[]): string {
  return parts
    .filter((p) => p !== '')
    .join('/')
    .replace(/\/+/g, '/')
}

export function basename(p: string, ext?: string): string {
  const base = p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? ''
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base
}

export function extname(p: string): string {
  const base = basename(p)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i) : ''
}

export function dirname(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i <= 0 ? '.' : norm.slice(0, i)
}

export function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(p) || /^[a-z]+:\/\//.test(p)
}

export function relative(from: string, to: string): string {
  const f = from.replace(/\\/g, '/').split('/').filter(Boolean)
  const t = to.replace(/\\/g, '/').split('/').filter(Boolean)
  let i = 0
  while (i < f.length && i < t.length && f[i] === t[i]) i++
  return [...f.slice(i).map(() => '..'), ...t.slice(i)].join('/')
}

export function resolve(...parts: string[]): string {
  return join(...parts)
}
