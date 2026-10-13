// Formulário das configurações deste perfil: validação com o mesmo schema zod do SW
// (settingsSchema, src/shared/protocol.ts) e mensagens no idioma da interface (Emenda 15). O
// resolver é escrito aqui porque o projeto não tem @hookform/resolvers; ele faz o mesmo papel do
// zodResolver.
import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form'
import type { z } from 'zod'
import { t, type MessageKey } from '../shared/i18n'
import { settingsSchema, transcriptionConfigSchema, type Settings, type TranscriptionConfig, type UiLanguage } from '../shared/protocol'

/**
 * O formulário deste perfil, salvo pelo "Salvar". Ficam de fora o idioma (Emenda 19) e a
 * transcrição por API (Emenda 21): os dois valem e são salvos na hora em que mudam, no formulário
 * próprio deles, e o Salvar mantém o que está guardado.
 */
export type ProfileForm = Omit<Settings, 'profileId' | 'language' | 'apiTranscription'>

export const profileFormSchema = settingsSchema.omit({ profileId: true, language: true, apiTranscription: true })

/** Os valores do formulário a partir das configurações guardadas (sem o id, o idioma e a API). */
export function profileFormDefaults(settings: Settings): ProfileForm {
  const { profileId: _id, language: _language, apiTranscription: _api, ...form } = settings
  return form
}

/**
 * Idiomas da interface (Emenda 19). O nome de cada língua aparece sempre na própria língua (não é
 * tradução, então não passa por t()); o automático, no idioma que vale agora.
 */
export const UI_LANGUAGE_OPTIONS: ReadonlyArray<
  { value: UiLanguage; labelKey: MessageKey; name?: undefined; lang?: undefined } | { value: UiLanguage; name: string; lang: string; labelKey?: undefined }
> = [
  { value: 'auto', labelKey: 'optLanguageAuto' },
  { value: 'pt_BR', name: 'Português (Brasil)', lang: 'pt-BR' },
  { value: 'en', name: 'English', lang: 'en' },
]

/**
 * Os números do vigia que quase ninguém precisa mexer, em "Ajustes finos" (Emenda 16), com o
 * rótulo e a explicação de cada um. O modo, a fração, a quantidade e as confirmações têm controle
 * próprio em "Quando sair".
 */
export const VIGIA_FINE_FIELDS: ReadonlyArray<{ key: 'intervaloSeg' | 'faltasParaFim' | 'picoParaQueda' | 'minimo'; labelKey: MessageKey; hintKey: MessageKey; step: string }> = [
  { key: 'intervaloSeg', labelKey: 'vigiaFieldInterval', hintKey: 'vigiaFieldIntervalHint', step: '1' },
  { key: 'faltasParaFim', labelKey: 'vigiaFieldMisses', hintKey: 'vigiaFieldMissesHint', step: '1' },
  { key: 'picoParaQueda', labelKey: 'vigiaFieldPeak', hintKey: 'vigiaFieldPeakHint', step: '1' },
  { key: 'minimo', labelKey: 'vigiaFieldMinimum', hintKey: 'vigiaFieldMinimumHint', step: '1' },
]

/** Rótulo de cada fração oferecida (uma fração guardada fora da lista aparece em %). */
const FRACTION_LABELS: ReadonlyArray<{ value: number; labelKey: MessageKey }> = [
  { value: 0.75, labelKey: 'fraction75' },
  { value: 0.5, labelKey: 'fraction50' },
  { value: 0.3, labelKey: 'fraction30' },
  { value: 0.25, labelKey: 'fraction25' },
]

export function fractionLabel(value: number): string {
  const known = FRACTION_LABELS.find((f) => f.value === value)
  return known ? t(known.labelKey) : t('fractionOther', String(Math.round(value * 100)))
}

/** "na hora" ou "20 s" para o tempo de confirmação. */
export function confirmLabel(seconds: number): string {
  return seconds > 0 ? t('confirmSeconds', String(seconds)) : t('confirmNow')
}

/**
 * Mensagem para um problema do zod, no idioma da interface. As mensagens próprias do schema
 * (protocol.ts, em português, porque o SW valida com o mesmo schema) são trocadas pelo campo.
 */
export function issueMessage(issue: z.core.$ZodIssue, values?: unknown): string {
  const field = String(issue.path[issue.path.length - 1] ?? '')
  // Quantas pessoas no modo "quantidade": uma frase só para qualquer problema do número.
  if (field === 'quantidade' && issue.code !== 'custom') return t('formPeopleRange')
  switch (issue.code) {
    case 'invalid_type':
      if (issue.expected === 'int') return t('formInteger')
      if (issue.expected === 'number') return t('formNumber')
      return t('formInvalid')
    case 'too_small':
      return issue.origin === 'string' ? t('formMinChars', String(issue.minimum)) : t('formMin', String(issue.minimum))
    case 'too_big':
      return issue.origin === 'string' ? t('formMaxChars', String(issue.maximum)) : t('formMax', String(issue.maximum))
    case 'custom':
    case 'invalid_format':
      if (field === 'fracao') return t('formFractionBelowOne')
      if (field === 'picoParaQueda') return t('formPeakAboveMinimum', String(minimumOf(values) ?? ''))
      if (field === 'modelo' || field === 'whisperCli' || field === 'ffmpeg') return t('formAbsolutePath')
      if (field === 'idioma') return t('formLanguageCode')
      return issue.message
    default:
      return t('formInvalid')
  }
}

/** O mínimo de pessoas do vigia nos valores do formulário (vai na mensagem do pico). */
function minimumOf(values: unknown): number | null {
  const v = (values as { vigia?: { minimo?: unknown } } | undefined)?.vigia?.minimo
  return typeof v === 'number' ? v : null
}

/** Prepara o que o usuário digitou: nome do perfil sem espaços nas pontas. */
export function cleanProfileForm(values: ProfileForm): ProfileForm {
  return { ...values, profileLabel: values.profileLabel.trim() }
}

/** Resolver do react-hook-form para um schema zod (erros aninhados, como o zodResolver faz). */
export function zodFormResolver<T extends FieldValues>(schema: z.ZodType<T>, clean: (v: T) => T = (v) => v): Resolver<T> {
  return async (values) => {
    const parsed = schema.safeParse(clean(values))
    if (parsed.success) return { values: parsed.data, errors: {} }
    const errors: Record<string, unknown> = {}
    for (const issue of parsed.error.issues) {
      let node = errors
      const path = issue.path.map(String)
      path.forEach((key, i) => {
        if (i === path.length - 1) {
          if (!node[key]) node[key] = { type: issue.code, message: issueMessage(issue, values) }
        } else node = (node[key] ??= {}) as Record<string, unknown>
      })
    }
    return { values: {}, errors: errors as FieldErrors<T> }
  }
}

/** Resolver das configurações deste perfil. */
export const profileFormResolver: Resolver<ProfileForm> = zodFormResolver<ProfileForm>(profileFormSchema as unknown as z.ZodType<ProfileForm>, cleanProfileForm)

/** Transcrição (Emenda 13): caminhos sem espaços nas pontas. */
export function cleanTranscriptionForm(values: TranscriptionConfig): TranscriptionConfig {
  return { ...values, modelo: values.modelo.trim(), whisperCli: values.whisperCli.trim(), ffmpeg: values.ffmpeg.trim() }
}

export const transcriptionFormResolver: Resolver<TranscriptionConfig> = zodFormResolver<TranscriptionConfig>(transcriptionConfigSchema, cleanTranscriptionForm)

/** Idiomas oferecidos no seletor (o helper aceita qualquer código; um diferente aparece também). */
export const TRANSCRIPTION_LANGUAGES: ReadonlyArray<{ value: string; labelKey: MessageKey }> = [
  { value: 'auto', labelKey: 'langAuto' },
  { value: 'pt', labelKey: 'langPt' },
  { value: 'en', labelKey: 'langEn' },
  { value: 'es', labelKey: 'langEs' },
  { value: 'fr', labelKey: 'langFr' },
  { value: 'de', labelKey: 'langDe' },
  { value: 'it', labelKey: 'langIt' },
]
