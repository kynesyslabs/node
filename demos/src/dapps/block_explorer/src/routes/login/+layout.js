export const prerender = false

export function load ({ url }) {
  return {
    url: url.pathname
  }
}
