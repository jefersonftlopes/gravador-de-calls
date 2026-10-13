// O que este bundle é (Emenda 17): a versão e o identificador do build, do vite.config.ts. Mora
// sozinho, sem dependências, para o offscreen (que não mostra texto) não carregar as mensagens das
// duas línguas que o version.ts traz junto com o i18n (Emenda 19).
import type { BuildInfo } from './protocol'

export const BAKED: BuildInfo = { version: __APP_VERSION__, build: __BUILD_ID__ }
