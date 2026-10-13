// Script do MAIN world: roda no document_start de toda frame do Meet e do Teams, ANTES do código
// da página. Gerado como IIFE síncrono e autocontido pelo crxjs (sufixo .iife.ts), referenciado
// direto no manifesto com world MAIN: sem loader e sem import() dinâmico (regra 8).
//
// Regras não negociáveis (docs/ARQUITETURA.md, "Regras do MAIN world"): original primeiro e
// retorno intacto; instalar uma vez por realm; nada de Trusted Types; nada nosso no
// AudioDestinationNode; nunca createEncodedStreams; nunca saída em AudioWorkletNode da página;
// construtor por Proxy; sem chrome.*. A instalação inteira fica dentro de try/catch (install.ts).
import { installHook } from './install'

installHook()
