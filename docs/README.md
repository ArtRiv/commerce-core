# Docs

Índice da documentação viva do projeto. Isto complementa (não substitui)
[`claude/context.md`](../claude/context.md), que tem o contexto geral e as
convenções combinadas para trabalhar com o Claude Code neste repo.

- [`workflow.md`](workflow.md) — como uma feature nasce aqui: spec →
  TDD → e2e → docs de arquitetura atualizados.
- [`security.md`](security.md) — padrões de segurança adotados no
  projeto (senha, tokens, rate limiting), com base no OWASP Cheat
  Sheet Series. Vale pro projeto inteiro, não só pro auth.
- [`specs/`](specs/) — specs por módulo/feature, escritas _antes_ da
  implementação. `TEMPLATE.md` é o ponto de partida.
- [`architecture/`](architecture/) — diagramas Mermaid da arquitetura
  (visão de contexto, mapa de módulos). Começam como desenho-alvo antes
  de qualquer módulo existir; atualize o diagrama sempre que a
  implementação divergir do que está desenhado, pra não virar
  documentação morta.
- [`specs/openapi.md`](specs/openapi.md) — a spec da documentação da
  API em si: como o documento OpenAPI é montado, por que a permissão de
  cada rota sai do mesmo decorator que a impõe, e o inventário auditado
  das 38 rotas (com as divergências spec ↔ código que a auditoria achou).
- [`status.md`](status.md) — o retrato do projeto: o que está no ar, o que
  a v1 entrega, o que ficou de fora de propósito, e o que quem for
  **consumir** esta API precisa saber antes de escrever a primeira
  requisição. Comece por aqui.
- [`deploy.md`](deploy.md) — runbook de produção: como o serviço no
  Render, o Supabase de produção e o webhook do Stripe são criados, o que
  fazer numa migration nova e o que muda no dia em que houver uma segunda
  instância. O _porquê_ de cada escolha está em
  [`specs/deploy.md`](specs/deploy.md).
- [`known-issues.md`](known-issues.md) — bugs e lacunas encontrados
  depois que um módulo já foi entregue, aceitos por ora mas não
  esquecidos. Não é backlog de feature (isso mora nas "decisões
  adiadas" de cada spec) — é especificamente coisa que está, de algum
  jeito pequeno, errada.
