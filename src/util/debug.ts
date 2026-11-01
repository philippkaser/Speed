// URL debug switches, e.g. ?nofog&nopost
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams()
export const debugFlag = (name: string) => params.has(name)
