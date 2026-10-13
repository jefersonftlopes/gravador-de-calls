// Tipos de scripts/verificar.mjs (usado pelos testes de unidade). Emenda 23.
export declare const STATE_VERSION: number

export interface ManifestState {
  arquivo: string
  instalado: boolean
  ids: string[]
  programa: string | null
  erro: string | null
}
export interface HelperState {
  pasta: string
  instalado: boolean
  arquivosFaltando: string[]
  versao: string | null
  versaoProjeto: string
  mesmaVersao: boolean
}
export interface RecordingsState {
  pasta: string
  origem: 'config' | 'padrao'
  existe: boolean
  config: string
  temConfig: boolean
}
export interface ModelState {
  caminho: string | null
  bytes: number | null
  gb: string | null
  configurado: boolean
  motivo: string | null
  pastas: string[]
}
export interface ProgramState {
  caminho: string | null
  configurado: boolean
  motivo: string | null
}
export interface VerifyState {
  versao: number
  pronto: boolean
  faltando: string[]
  manifesto: ManifestState
  helper: HelperState
  gravacoes: RecordingsState
  modelo: ModelState
  whisperCli: ProgramState
  ffmpeg: ProgramState
  transcricao: { ativa: boolean; motor: string; idioma: string }
}

export declare function gbLabel(bytes: number): string
/**
 * As pastas entram por parâmetro: o teste roda num HOME falso sem tocar na instalação de verdade.
 * `env`, `fallbackDirs` e `modelDirs` têm o mesmo papel que no `ctx` do motor (createEngine).
 */
export declare function collectState(opts?: {
  env?: NodeJS.ProcessEnv
  home?: string
  manifestDir?: string
  binDir?: string
  fallbackDirs?: string[]
  modelDirs?: string[]
}): Promise<VerifyState>
export declare function lines(state: VerifyState): string[]
