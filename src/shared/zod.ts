// O zod da extensão, sempre sem JIT (Emenda 15).
//
// Sem `jitless`, o zod testa se pode compilar validadores com `Function(...)`. No Manifest V3 a CSP
// recusa (o teste falha em silêncio, mas o Chrome registra a violação), e um revisor da loja vê
// a chamada. Com `jitless` o teste nem roda. Todo código da extensão importa o zod daqui, para a
// configuração valer antes do primeiro schema.
import { z } from 'zod'

z.config({ jitless: true })

export { z }
