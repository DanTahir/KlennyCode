import type { KlennyApi } from '@shared/ipc'

declare global {
  interface Window {
    klenny: KlennyApi
  }
}

declare module '*.jpg' {
  const src: string
  export default src
}

export {}
